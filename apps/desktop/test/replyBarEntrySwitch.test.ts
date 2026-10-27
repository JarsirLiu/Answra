import { describe, expect, it, vi } from "vitest";

/**
 * 迁移期验证：独立回复窗口入口单点关闭。
 * 主窗口已统一为内联 ReplySlot，setReplyBarWindowState 必须忽略非空状态（不创建独立窗口），
 * 仅放行 null 以清理残留。四个窗口控制器整体 mock，隔离窗口生命周期。
 */

const spies = vi.hoisted(() => ({
  replySetState: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: class {},
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }),
  },
}));

vi.mock("../src/main/mainWindowController", () => ({
  createMainWindowController: () => ({
    clampToWorkArea: vi.fn(),
    create: vi.fn(),
    getWindow: () => undefined,
    resizeToContent: vi.fn(),
  }),
}));

vi.mock("../src/main/replyBarWindowController", () => ({
  createReplyBarWindowController: () => ({
    close: vi.fn(),
    getConversationId: () => undefined,
    getWindow: () => undefined,
    hideForCapture: () => false,
    isFromSender: () => false,
    resize: vi.fn(),
    restoreAfterCapture: vi.fn(),
    sendState: vi.fn(),
    setAnchor: vi.fn(),
    setState: spies.replySetState,
  }),
}));

vi.mock("../src/main/ime/imeCandidateWindowController", () => ({
  createImeCandidateWindowController: () => ({
    dispose: vi.fn(),
    getWindow: () => undefined,
    isCandidateContents: () => false,
    markRendererReady: vi.fn(),
    resize: vi.fn(),
    routeAction: vi.fn(),
    update: vi.fn(),
    warmup: vi.fn(),
  }),
}));

vi.mock("../src/main/windowStealthController", () => ({
  createWindowStealthController: () => ({
    apply: vi.fn(),
    isEnabled: () => false,
    isSupported: () => false,
    refresh: vi.fn(),
  }),
  isolateNativeIme: vi.fn(),
  restoreNativeIme: vi.fn(),
}));

vi.mock("../src/main/windowSurfaceRegistry", () => ({
  createWindowSurfaceRegistry: () => ({
    attachAbove: vi.fn(),
    prepareToShow: () => true,
    refresh: vi.fn(),
    register: vi.fn(),
    setStealthEnabled: vi.fn(),
    subscribeFocus: vi.fn(),
  }),
}));

import { setReplyBarWindowState } from "../src/main/window";

describe("detached reply window entry switch", () => {
  it("ignores non-null states and only forwards null to the controller", () => {
    setReplyBarWindowState({ phase: "composing" } as never);
    expect(spies.replySetState).not.toHaveBeenCalled();

    setReplyBarWindowState({ phase: "streaming", replyText: "token" } as never);
    expect(spies.replySetState).not.toHaveBeenCalled();

    setReplyBarWindowState(null);
    expect(spies.replySetState).toHaveBeenCalledExactlyOnceWith(null);
  });
});
