import { ActiveInterviewConversationId } from "@answra/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewTextChatPanel } from "../../src/interview/chat/InterviewTextChatPanel";
import { createConversationBridge, resetFloatingBarTestState } from "../support/floatingBarHarness";

const mic = vi.hoisted(() => ({
  toggle: vi.fn(),
  stop: vi.fn(async () => undefined),
  active: false,
  starting: false,
  error: undefined as string | undefined,
  level: 0,
}));

vi.mock("../../src/interview/voice/useInterviewMicrophone", () => ({
  useInterviewMicrophone: () => ({
    active: mic.active,
    starting: mic.starting,
    error: mic.error,
    level: mic.level,
    toggle: mic.toggle,
    stop: mic.stop,
  }),
}));

function renderPanel(mode: "rehearsal" | "assist" = "rehearsal") {
  const bridge = {
    ...createConversationBridge(),
    stopTts: vi.fn(),
  };
  render(
    <InterviewTextChatPanel
      mode={mode}
      onClose={() => undefined}
      onModeChange={() => undefined}
      platform={bridge}
    />,
  );
  return bridge;
}

describe("rehearsal microphone", () => {
  beforeEach(() => {
    resetFloatingBarTestState();
    mic.active = false;
    mic.starting = false;
    mic.error = undefined;
    mic.level = 0;
    mic.toggle.mockReset();
    mic.stop.mockReset().mockResolvedValue(undefined);
  });

  it("interrupts narration and starts capture from the rehearsal header", async () => {
    const bridge = renderPanel();

    const button = await screen.findByRole("button", { name: "开始语音输入" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    button.click();

    expect(bridge.stopTts).toHaveBeenCalledWith({
      conversationId: ActiveInterviewConversationId,
    });
    expect(mic.toggle).toHaveBeenCalledOnce();
  });

  it("shows a stop action and the real input level while capturing", async () => {
    mic.active = true;
    mic.level = 0.75;
    renderPanel();

    const button = await screen.findByRole("button", { name: "停止语音输入" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".interview-mic-level > span")).toHaveStyle({ width: "75%" });

    button.click();
    expect(mic.toggle).toHaveBeenCalledOnce();
  });

  it("does not narrate or expose a microphone in assist mode", async () => {
    const bridge = renderPanel("assist");

    await screen.findByText("面试辅助");
    expect(screen.queryByRole("button", { name: "开始语音输入" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止语音输入" })).not.toBeInTheDocument();
    expect(bridge.stopTts).not.toHaveBeenCalled();
  });

  it("surfaces microphone errors alongside chat errors", async () => {
    mic.error = "未找到麦克风设备";
    renderPanel();

    expect(await screen.findByText("未找到麦克风设备")).toBeInTheDocument();
    expect(screen.getByLabelText("输入消息")).toBeInTheDocument();
  });
});
