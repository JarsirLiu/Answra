import { AUTH_REQUIRED_NOTICE } from "@answra/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewIntakePanel } from "../../src/interview/intake/InterviewIntakePanel";
import { createConversationBridge, resetFloatingBarTestState } from "../support/floatingBarHarness";

const mic = vi.hoisted(() => ({
  toggle: vi.fn(),
  stop: vi.fn(async () => undefined),
  active: false,
  starting: false,
  error: undefined as string | undefined,
  modelFailure: false,
  needsSignIn: false,
  needsModelSetup: false,
  level: 0,
}));

vi.mock("../../src/interview/voice/useInterviewMicrophone", () => ({
  useInterviewMicrophone: () => ({
    active: mic.active,
    starting: mic.starting,
    error: mic.error,
    modelFailure: mic.modelFailure,
    needsSignIn: mic.needsSignIn,
    needsModelSetup: mic.needsModelSetup,
    level: mic.level,
    toggle: mic.toggle,
    stop: mic.stop,
  }),
}));

function renderPanel(onStartRehearsal = vi.fn(async () => undefined)) {
  const bridge = {
    ...createConversationBridge(),
    loginAccount: vi.fn(async () => ({ opened: true })),
  };
  const onConfigureModel = vi.fn();
  render(
    <InterviewIntakePanel
      onClose={() => undefined}
      onConfigureModel={onConfigureModel}
      onReopenOnboarding={vi.fn(async () => undefined)}
      onStartRehearsal={onStartRehearsal}
      platform={bridge}
    />,
  );
  return { onStartRehearsal, bridge, onConfigureModel };
}

describe("interview intake microphone", () => {
  beforeEach(() => {
    resetFloatingBarTestState();
    mic.active = false;
    mic.starting = false;
    mic.error = undefined;
    mic.modelFailure = false;
    mic.needsSignIn = false;
    mic.needsModelSetup = false;
    mic.level = 0;
    mic.toggle.mockReset();
    mic.stop.mockReset().mockResolvedValue(undefined);
  });

  it("exposes a labelled microphone action that toggles capture", async () => {
    renderPanel();

    const button = await screen.findByRole("button", { name: "开始语音输入" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    button.click();
    expect(mic.toggle).toHaveBeenCalledOnce();
  });

  it("switches to a stop action once capture is active", async () => {
    mic.active = true;
    renderPanel();

    const button = await screen.findByRole("button", { name: "停止语音输入" });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("surfaces microphone failures without blocking the chat", async () => {
    mic.error = "麦克风权限被拒绝或已取消";
    renderPanel();

    expect(await screen.findByText("麦克风权限被拒绝或已取消")).toBeInTheDocument();
    expect(screen.getByLabelText("输入消息")).toBeInTheDocument();
  });

  it("stops capture before switching to the rehearsal stage", async () => {
    const order: string[] = [];
    mic.stop.mockImplementation(async () => {
      order.push("stop");
    });
    const { onStartRehearsal } = renderPanel(
      vi.fn(async () => {
        order.push("rehearsal");
      }),
    );

    const button = await screen.findByRole("button", { name: "开始面试演练" });
    button.click();

    await waitFor(() => expect(order).toEqual(["stop", "rehearsal"]));
    expect(onStartRehearsal).toHaveBeenCalledOnce();
  });

  it("offers login and model setup instead of an IPC error when voice needs auth", async () => {
    mic.error = AUTH_REQUIRED_NOTICE;
    mic.modelFailure = true;
    mic.needsSignIn = true;
    const { bridge, onConfigureModel } = renderPanel();

    expect(await screen.findByText(AUTH_REQUIRED_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(/Error invoking remote method/u)).not.toBeInTheDocument();
    screen.getByRole("button", { name: "去登录" }).click();
    screen.getByRole("button", { name: "配置本地模型" }).click();

    expect(bridge.loginAccount).toHaveBeenCalledOnce();
    expect(onConfigureModel).toHaveBeenCalledOnce();
  });
});
