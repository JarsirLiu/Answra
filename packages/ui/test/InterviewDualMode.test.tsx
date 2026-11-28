import type { InterviewOnboardingState } from "@answra/shared";
import { ActiveInterviewConversationId } from "@answra/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import { createConversationBridge, resetFloatingBarTestState } from "./support/floatingBarHarness";

const READY_STATE: InterviewOnboardingState = {
  version: 2,
  status: "completed",
  step: "ready",
  resume: null,
  projects: [],
  selectedProjectIds: [],
  targetRole: "",
  rehearsalStartedAt: "2026-11-27T08:30:00.000Z",
  updatedAt: "2026-11-27T08:00:00.000Z",
};

function createDualModeBridge() {
  return {
    ...createConversationBridge(),
    getInterviewOnboardingState: vi.fn(async () => READY_STATE),
    loginAccount: vi.fn(async () => ({ opened: true })),
  };
}

function openInterview(): void {
  fireEvent.click(screen.getByRole("button", { name: "对话" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
}

describe("interview rehearsal and assist modes", () => {
  beforeEach(() => {
    resetFloatingBarTestState();
  });

  it("defaults to rehearsal with the interviewer icon and opens its own session", async () => {
    const bridge = createDualModeBridge();
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    expect(await screen.findByText("面试演练")).toBeInTheDocument();
    await waitFor(() => expect(bridge.openInterviewRehearsal).toHaveBeenCalledOnce());
    expect(bridge.openInterviewAssist).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "面试官模式：面试演练" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "候选者模式：面试辅助" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("switches to the candidate assist session and routes only assist messages to the coach", async () => {
    const bridge = createDualModeBridge();
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    await screen.findByText("面试演练");
    fireEvent.click(screen.getByRole("button", { name: "候选者模式：面试辅助" }));

    expect(await screen.findByText("面试辅助")).toBeInTheDocument();
    await waitFor(() => expect(bridge.openInterviewAssist).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "候选者模式：面试辅助" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "面试官模式：面试演练" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const input = await screen.findByLabelText("输入消息");
    fireEvent.change(input, { target: { value: "讲讲你做过的项目" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() =>
      expect(bridge.sendInterviewAssistMessage).toHaveBeenCalledWith("讲讲你做过的项目"),
    );
    expect(bridge.sendInterviewMessage).not.toHaveBeenCalled();
  });

  it("keeps rehearsal and assist transcripts separate when switching back", async () => {
    const bridge = createDualModeBridge();
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    await screen.findByText("面试演练");
    const rehearsalInput = await screen.findByLabelText("输入消息");
    fireEvent.change(rehearsalInput, { target: { value: "开始演练" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() =>
      expect(bridge.sendInterviewMessage).toHaveBeenCalledWith(
        ActiveInterviewConversationId,
        "开始演练",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "候选者模式：面试辅助" }));
    expect(await screen.findByText("面试辅助")).toBeInTheDocument();
    expect(screen.queryByText("开始演练")).not.toBeInTheDocument();
  });

  it("switches back to intake when the main process ends the rehearsal", async () => {
    let push: ((state: InterviewOnboardingState) => void) | undefined;
    const bridge = {
      ...createConversationBridge(),
      getInterviewOnboardingState: vi.fn(async () => READY_STATE),
      onInterviewOnboardingChanged: vi.fn((listener: (state: InterviewOnboardingState) => void) => {
        push = listener;
        return () => undefined;
      }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();
    await screen.findByText("面试演练");

    act(() => push?.({ ...READY_STATE, rehearsalStartedAt: null }));

    expect(await screen.findByText("制作面试分身")).toBeInTheDocument();
    await waitFor(() => expect(bridge.openInterviewIntake).toHaveBeenCalledOnce());
  });

  it("shows a clean sign-in notice instead of the raw IPC error when cloud send needs login", async () => {
    const bridge = createDualModeBridge();
    vi.mocked(bridge.sendInterviewMessage).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'answra:interview:rehearsal-message': Error: auth-required: 请先登录后再使用（设置 → 账户）",
      ),
    );
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    const input = await screen.findByLabelText("输入消息");
    fireEvent.change(input, { target: { value: "开始演练" } });
    // 打开面试是异步的：未结束前发送按钮禁用，负载下要等它可用再点。
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    await waitFor(() => expect(sendButton).toBeEnabled());
    fireEvent.click(sendButton);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("请先登录后再使用（设置 → 账户）");
    expect(alert).not.toHaveTextContent("Error invoking remote method");
    fireEvent.click(screen.getByRole("button", { name: "去登录" }));
    expect(bridge.loginAccount).toHaveBeenCalledOnce();
  });

  it("offers local model configuration alongside sign-in in the interview panel", async () => {
    const bridge = {
      ...createDualModeBridge(),
      getConversationConfig: vi.fn(async () => ({
        source: "cloud" as const,
        localAvailable: true,
        baseUrl: "",
        model: "",
        answerModel: "",
        configured: false,
      })),
    };
    vi.mocked(bridge.sendInterviewMessage).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'answra:interview:rehearsal-message': Error: auth-required: 请先登录后再使用（设置 → 账户）",
      ),
    );
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    const input = await screen.findByLabelText("输入消息");
    fireEvent.change(input, { target: { value: "开始演练" } });
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    await waitFor(() => expect(sendButton).toBeEnabled());
    fireEvent.click(sendButton);

    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "配置本地模型" }));

    expect(await screen.findByRole("checkbox", { name: /跟随背景色/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "模型" })).toBeInTheDocument();
  });

  it("keeps the header to the title, two mode buttons and close", async () => {
    const bridge = createDualModeBridge();
    render(<FloatingBarApp bridge={bridge} />);
    openInterview();

    expect(await screen.findByText("面试演练")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "资料" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "面试官模式：面试演练" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "候选者模式：面试辅助" })).toBeInTheDocument();
  });
});
