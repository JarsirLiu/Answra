import type { InterviewOnboardingState } from "@answra/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import { createConversationBridge, resetFloatingBarTestState } from "./support/floatingBarHarness";

const projectA = {
  id: "project-a",
  name: "Answra 桌面助手",
  role: "前端负责人",
  period: "2024.01-2025.06",
  summary: "负责桌面端引导与面试面板。",
};

const projectB = {
  id: "project-b",
  name: "数据平台",
  summary: "负责数据看板和权限模块。",
};

function onboardingState(
  overrides: Partial<InterviewOnboardingState> = {},
): InterviewOnboardingState {
  return {
    version: 1,
    status: "pending",
    step: "resume",
    resume: null,
    selectedProjectIds: [],
    targetRole: "",
    updatedAt: "2026-11-11T08:00:00.000Z",
    ...overrides,
  };
}

function capturePort() {
  return {
    getState: () => ({ phase: "idle" as const }),
    subscribe: () => () => undefined,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

function createOnboardingBridge(initial: InterviewOnboardingState) {
  let current = initial;
  const bridge = createConversationBridge();
  return {
    ...bridge,
    getInterviewOnboardingState: vi.fn(async () => current),
    pickInterviewResume: vi.fn(async () => {
      current = onboardingState({
        step: "projects",
        resume: { id: "resume-1", fileName: "张三简历.md", projects: [projectA, projectB] },
        selectedProjectIds: [projectA.id, projectB.id],
      });
      return { cancelled: false, state: current };
    }),
    importInterviewResume: vi.fn(async () => current),
    updateInterviewOnboarding: vi.fn(async (patch) => {
      current = { ...current, ...patch };
      return current;
    }),
    addInterviewOnboardingProject: vi.fn(async () => current),
    completeInterviewOnboarding: vi.fn(async () => {
      current = { ...current, status: "completed" };
      return current;
    }),
    skipInterviewOnboarding: vi.fn(async () => {
      current = { ...current, status: "skipped" };
      return current;
    }),
  };
}

function openInterview() {
  fireEvent.click(screen.getByRole("button", { name: "对话" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
  fireEvent.click(screen.getByRole("button", { name: "面试演练" }));
}

describe("interview onboarding panel", () => {
  beforeEach(resetFloatingBarTestState);

  it("opens the resume guide before the rehearsal panel", async () => {
    const bridge = createOnboardingBridge(onboardingState());
    render(<FloatingBarApp bridge={bridge} interviewCapture={capturePort()} />);
    openInterview();

    expect(await screen.findByRole("heading", { name: "先让面试分身认识你" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始面试演练" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "选择简历" }));

    await waitFor(() => expect(bridge.pickInterviewResume).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("heading", { name: "挑出你想重点讲的项目" }),
    ).toBeInTheDocument();
  });

  it("selects projects, saves the target role, and completes onboarding", async () => {
    const bridge = createOnboardingBridge(
      onboardingState({
        step: "projects",
        resume: { id: "resume-1", fileName: "张三简历.md", projects: [projectA, projectB] },
        selectedProjectIds: [projectA.id, projectB.id],
      }),
    );
    render(<FloatingBarApp bridge={bridge} interviewCapture={capturePort()} />);
    openInterview();

    const checkboxes = await screen.findAllByRole("checkbox");
    const secondProject = checkboxes[1];
    if (!secondProject) throw new Error("second project checkbox missing");
    fireEvent.click(secondProject);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    await waitFor(() =>
      expect(bridge.updateInterviewOnboarding).toHaveBeenCalledWith({
        step: "ready",
        selectedProjectIds: [projectA.id],
      }),
    );
    expect(await screen.findByRole("heading", { name: "开始制作面试分身" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("目标岗位（可选）"), {
      target: { value: "高级前端工程师" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并进入面试演练" }));

    await waitFor(() =>
      expect(bridge.updateInterviewOnboarding).toHaveBeenLastCalledWith({
        step: "ready",
        selectedProjectIds: [projectA.id],
        targetRole: "高级前端工程师",
      }),
    );
    expect(bridge.completeInterviewOnboarding).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "开始面试演练" })).toBeInTheDocument();
  });

  it("skips onboarding without blocking the rehearsal panel", async () => {
    const bridge = createOnboardingBridge(onboardingState());
    render(<FloatingBarApp bridge={bridge} interviewCapture={capturePort()} />);
    openInterview();

    fireEvent.click(await screen.findByRole("button", { name: "稍后再说" }));

    await waitFor(() => expect(bridge.skipInterviewOnboarding).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "开始面试演练" })).toBeInTheDocument();
  });

  it("restores the saved step when the panel is reopened", async () => {
    const bridge = createOnboardingBridge(
      onboardingState({
        step: "ready",
        resume: { id: "resume-1", fileName: "张三简历.md", projects: [projectA] },
        selectedProjectIds: [projectA.id],
      }),
    );
    render(<FloatingBarApp bridge={bridge} interviewCapture={capturePort()} />);
    openInterview();

    expect(await screen.findByRole("heading", { name: "开始制作面试分身" })).toBeInTheDocument();
    expect(screen.getByText("张三简历.md")).toBeInTheDocument();
    expect(screen.getByText("1 个")).toBeInTheDocument();
  });

  it("does not show onboarding after it has been completed", async () => {
    const bridge = createOnboardingBridge(onboardingState({ status: "completed", step: "ready" }));
    render(<FloatingBarApp bridge={bridge} interviewCapture={capturePort()} />);
    openInterview();

    expect(await screen.findByRole("button", { name: "开始面试演练" })).toBeInTheDocument();
    expect(screen.queryByText("先让面试分身认识你")).not.toBeInTheDocument();
  });
});
