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
    reopenInterviewOnboarding: vi.fn(async () => {
      current = {
        ...current,
        status: "pending",
        step: current.resume ? current.step : "resume",
      };
      return current;
    }),
  };
}

function openInterview() {
  fireEvent.click(screen.getByRole("button", { name: "对话" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
}

describe("interview onboarding panel", () => {
  beforeEach(resetFloatingBarTestState);

  it("does not open the guide until the user switches to interview mode", async () => {
    const bridge = createOnboardingBridge(onboardingState());
    render(<FloatingBarApp bridge={bridge} />);

    expect(screen.queryByRole("heading", { name: "先让面试分身认识你" })).not.toBeInTheDocument();
    expect(bridge.getInterviewOnboardingState).not.toHaveBeenCalled();

    openInterview();

    expect(await screen.findByRole("heading", { name: "先让面试分身认识你" })).toBeInTheDocument();
    expect(bridge.getInterviewOnboardingState).toHaveBeenCalledOnce();
  });

  it("opens the resume guide before the avatar panel", async () => {
    const bridge = createOnboardingBridge(onboardingState());
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    expect(await screen.findByRole("heading", { name: "先让面试分身认识你" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "面试分身制作中" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "上传简历" }));

    await waitFor(() => expect(bridge.pickInterviewResume).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("heading", { name: "挑出你想重点讲的项目" }),
    ).toBeInTheDocument();
  });

  it("advances from the resume step without requiring a resume", async () => {
    const bridge = createOnboardingBridge(onboardingState());
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    fireEvent.click(await screen.findByRole("button", { name: "下一步" }));

    await waitFor(() =>
      expect(bridge.updateInterviewOnboarding).toHaveBeenCalledWith({ step: "projects" }),
    );
    expect(
      await screen.findByRole("heading", { name: "挑出你想重点讲的项目" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一步" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "手动添加" })).not.toBeInTheDocument();
  });

  it("shows a visual empty state with short actions when the resume has no projects", async () => {
    const bridge = createOnboardingBridge(
      onboardingState({
        step: "projects",
        resume: { id: "resume-1", fileName: "空简历.md", projects: [] },
      }),
    );
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    expect(
      await screen.findByRole("heading", { name: "挑出你想重点讲的项目" }),
    ).toBeInTheDocument();
    expect(screen.getByText("没识别到项目")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "换份简历" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一步" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "手动添加" }));
    expect(await screen.findByLabelText("项目名称")).toBeInTheDocument();
  });

  it("selects projects, saves the target role, and completes onboarding", async () => {
    const bridge = createOnboardingBridge(
      onboardingState({
        step: "projects",
        resume: { id: "resume-1", fileName: "张三简历.md", projects: [projectA, projectB] },
        selectedProjectIds: [projectA.id, projectB.id],
      }),
    );
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    const checkboxes = await screen.findAllByRole("checkbox");
    const secondProject = checkboxes[1];
    if (!secondProject) throw new Error("second project checkbox missing");
    fireEvent.click(secondProject);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

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
    fireEvent.click(screen.getByRole("button", { name: "开始制作面试分身" }));

    await waitFor(() =>
      expect(bridge.updateInterviewOnboarding).toHaveBeenLastCalledWith({
        step: "ready",
        selectedProjectIds: [projectA.id],
        targetRole: "高级前端工程师",
      }),
    );
    expect(bridge.completeInterviewOnboarding).toHaveBeenCalledOnce();
    expect(await screen.findByRole("heading", { name: "面试分身制作中" })).toBeInTheDocument();
  });

  it("navigates back with previous and forward with next", async () => {
    const bridge = createOnboardingBridge(
      onboardingState({
        step: "projects",
        resume: { id: "resume-1", fileName: "张三简历.md", projects: [projectA, projectB] },
        selectedProjectIds: [projectA.id, projectB.id],
      }),
    );
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    expect(
      await screen.findByRole("heading", { name: "挑出你想重点讲的项目" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    await waitFor(() =>
      expect(bridge.updateInterviewOnboarding).toHaveBeenCalledWith({ step: "resume" }),
    );
    expect(await screen.findByRole("heading", { name: "先让面试分身认识你" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await waitFor(() =>
      expect(bridge.updateInterviewOnboarding).toHaveBeenLastCalledWith({ step: "projects" }),
    );
    expect(
      await screen.findByRole("heading", { name: "挑出你想重点讲的项目" }),
    ).toBeInTheDocument();
  });

  it("skips one step at a time and reopens the guide from the avatar panel", async () => {
    const bridge = createOnboardingBridge(
      onboardingState({
        resume: { id: "resume-1", fileName: "张三简历.md", projects: [projectA] },
      }),
    );
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    fireEvent.click(await screen.findByRole("button", { name: "跳过这一步" }));
    await waitFor(() =>
      expect(bridge.updateInterviewOnboarding).toHaveBeenCalledWith({ step: "projects" }),
    );
    expect(
      await screen.findByRole("heading", { name: "挑出你想重点讲的项目" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "跳过这一步" }));
    await waitFor(() =>
      expect(bridge.updateInterviewOnboarding).toHaveBeenLastCalledWith({
        step: "ready",
        selectedProjectIds: [],
      }),
    );
    expect(await screen.findByRole("heading", { name: "开始制作面试分身" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "跳过引导" }));
    await waitFor(() => expect(bridge.skipInterviewOnboarding).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "还没有面试资料" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "完善面试资料" }));
    await waitFor(() => expect(bridge.reopenInterviewOnboarding).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "开始制作面试分身" })).toBeInTheDocument();
  });

  it("does not offer skip-all or a local-only hint on the resume step", async () => {
    const bridge = createOnboardingBridge(onboardingState());
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    expect(await screen.findByRole("heading", { name: "先让面试分身认识你" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传简历" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一步" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "跳过引导" })).not.toBeInTheDocument();
    expect(screen.queryByText("只保存在本机")).not.toBeInTheDocument();
  });

  it("restores the saved step when the panel is reopened", async () => {
    const bridge = createOnboardingBridge(
      onboardingState({
        step: "ready",
        resume: { id: "resume-1", fileName: "张三简历.md", projects: [projectA] },
        selectedProjectIds: [projectA.id],
      }),
    );
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    expect(await screen.findByRole("heading", { name: "开始制作面试分身" })).toBeInTheDocument();
    expect(screen.getByText("候选人档案")).toBeInTheDocument();
    expect(screen.getByText("张三简历.md")).toBeInTheDocument();
    expect(screen.getByText("1 个")).toBeInTheDocument();
    expect(screen.getByText(projectA.name)).toBeInTheDocument();
  });

  it("does not show onboarding after it has been completed", async () => {
    const bridge = createOnboardingBridge(onboardingState({ status: "completed", step: "ready" }));
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    expect(await screen.findByRole("heading", { name: "面试分身制作中" })).toBeInTheDocument();
    expect(screen.queryByText("先让面试分身认识你")).not.toBeInTheDocument();
  });
});
