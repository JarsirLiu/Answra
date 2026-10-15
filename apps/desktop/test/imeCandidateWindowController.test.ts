import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]) => {
        this.removeListener(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((current) => current !== listener),
      );
      return this;
    }

    removeAllListeners(): void {
      this.listeners.clear();
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.length ?? 0;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  class MockWindow extends Emitter {
    static nextId = 1;
    readonly id = MockWindow.nextId++;
    readonly sent: unknown[][] = [];
    readonly webContents = Object.assign(new Emitter(), {
      send: (...args: unknown[]) => this.sent.push(args),
      setWindowOpenHandler: () => undefined,
    });
    bounds: Electron.Rectangle;
    parent: MockWindow | null = null;
    visible = false;
    destroyed = false;
    alwaysOnTopCalls: unknown[][] = [];

    constructor(options: Partial<Electron.Rectangle>) {
      super();
      this.bounds = { x: 0, y: 0, width: 640, height: 56, ...options };
      shared.windows.push(this);
    }

    getBounds() {
      return this.bounds;
    }

    getContentBounds() {
      return this.bounds;
    }

    isDestroyed() {
      return this.destroyed;
    }

    isVisible() {
      return this.visible;
    }

    isMinimized() {
      return false;
    }

    isFocused() {
      return false;
    }

    isAlwaysOnTop() {
      return true;
    }

    isFocusable() {
      return false;
    }

    getNativeWindowHandle() {
      return Buffer.from([this.id, 0, 0, 0]);
    }

    setBounds(bounds: Electron.Rectangle) {
      this.bounds = bounds;
    }

    setParentWindow(parent: MockWindow | null) {
      this.parent = parent;
    }

    showInactive() {
      this.visible = true;
      this.emit("show");
    }

    hide() {
      this.visible = false;
      this.emit("hide");
    }

    close() {
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }

    setAlwaysOnTop(...args: unknown[]) {
      this.alwaysOnTopCalls.push(args);
    }
    setSkipTaskbar() {}
    loadURL() {
      return Promise.resolve();
    }
    loadFile() {
      return Promise.resolve();
    }
  }

  class MockScreen extends Emitter {
    getDisplayNearestPoint() {
      return {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1,
      };
    }
  }

  return {
    windows: [] as MockWindow[],
    appFocused: true,
    focusedWindow: vi.fn(() => undefined as MockWindow | undefined),
    MockWindow,
    screen: new MockScreen(),
    setCaptureProtection: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: { isPackaged: false, isFocused: () => shared.appFocused },
  BrowserWindow: Object.assign(shared.MockWindow, { getFocusedWindow: shared.focusedWindow }),
  screen: shared.screen,
}));

vi.mock("../src/main/windowCaptureProtection", () => ({
  setWindowCaptureProtection: shared.setCaptureProtection,
  getWindowCaptureDiagnostics: (window: shared.MockWindow) => ({
    nativeHandle: `0x${window.id.toString(16)}`,
    bounds: window.getBounds(),
    visible: window.isVisible(),
    reportedProtected: true,
  }),
}));

vi.mock("../src/main/windowInteractionPolicy", () => ({}));

vi.mock("../src/main/windowForeground", () => ({
  isCurrentProcessForeground: () => shared.appFocused,
}));

vi.mock("../src/main/ime/imeDiagnostics", () => ({
  logImeDiagnostic: vi.fn(),
}));

import { ImeCandidateChannels, type ImeState } from "@answra/shared";
import {
  createImeCandidateWindowController,
  resolveImeCandidateWindowPaths,
} from "../src/main/ime/imeCandidateWindowController";
import { logImeDiagnostic } from "../src/main/ime/imeDiagnostics";

const state: ImeState = {
  enabled: true,
  composing: true,
  preedit: "ni",
  candidates: [{ text: "你" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

describe("IME candidate window controller", () => {
  beforeEach(() => {
    shared.windows = [];
    shared.appFocused = true;
    shared.focusedWindow.mockReset().mockReturnValue(undefined);
    shared.MockWindow.nextId = 1;
    shared.setCaptureProtection.mockClear();
    vi.mocked(logImeDiagnostic).mockClear();
    shared.screen.removeAllListeners();
  });

  it("resolves resources relative to the compiled main bundle", () => {
    expect(resolveImeCandidateWindowPaths("C:\\app\\out\\main")).toEqual({
      preload: "C:\\app\\out\\preload\\index.cjs",
      renderer: "C:\\app\\dist\\index.html",
    });
  });

  it("owns candidate window geometry and routes actions to the current input owner", () => {
    const owner = new shared.MockWindow({ x: 100, y: 50, width: 800, height: 600 });
    const controller = createImeCandidateWindowController({
      isOwnerWindow: (candidate) => candidate === owner,
      registerWindowSurface: (window, descriptor) => {
        if (descriptor.captureProtection === "stealth-only")
          shared.setCaptureProtection(window, true);
      },
      prepareWindowToShow: () => true,
      attachAbove: (child, owner) => child.setParentWindow(owner),
    });
    controller.update(owner as never, {
      type: "show",
      state,
      anchor: { x: 240, lineTop: 120, lineBottom: 144 },
      targetId: "composer",
      generation: 1,
    });
    const candidate = shared.windows.at(-1);
    if (!candidate) throw new Error("candidate window was not created");

    expect(candidate.visible).toBe(false);
    expect(candidate.parent).toBe(owner);
    expect(shared.setCaptureProtection).toHaveBeenCalledWith(candidate, true);

    controller.markRendererReady();
    expect(candidate.visible).toBe(false);

    candidate.webContents.emit("did-finish-load");
    expect(candidate.visible).toBe(true);
    expect(candidate.parent).toBe(owner);
    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "candidate-native-positioned",
      expect.objectContaining({
        nativeHandle: expect.any(String),
        visible: false,
        alwaysOnTop: true,
        focusable: false,
        captureProtection: expect.objectContaining({ reportedProtected: true }),
        display: expect.objectContaining({ scaleFactor: 1 }),
      }),
    );
    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "candidate-native-show",
      expect.objectContaining({ visible: true, alwaysOnTop: true }),
    );
    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "candidate-native-show",
      expect.objectContaining({ visible: true, alwaysOnTop: true }),
    );
    expect(candidate.bounds).toMatchObject({ x: 332, y: 192 });
    expect(candidate.sent).toContainEqual([
      ImeCandidateChannels.State,
      { state, targetId: "composer", generation: 1 },
    ]);
    const action = { type: "select", index: 0, targetId: "composer", generation: 1 } as const;
    controller.routeAction(action);
    expect(owner.sent).toContainEqual([ImeCandidateChannels.OwnerAction, action]);

    controller.update(owner as never, { type: "clear", targetId: "composer", generation: 0 });
    expect(candidate.visible).toBe(true);
    controller.update(owner as never, { type: "clear", targetId: "composer", generation: 1 });
    expect(candidate.visible).toBe(false);
    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "candidate-native-hide-result",
      expect.objectContaining({ visible: false, reason: "owner-reported-no-candidates" }),
    );
    controller.routeAction(action);
    expect(owner.sent).toHaveLength(1);
    controller.dispose();
  });

  it("logs anchor lifecycle and candidate state when the owner regains focus", () => {
    const owner = new shared.MockWindow({ x: 100, y: 50, width: 800, height: 600 });
    const controller = createImeCandidateWindowController({
      isOwnerWindow: (candidate) => candidate === owner,
      registerWindowSurface: vi.fn(),
      prepareWindowToShow: () => true,
      attachAbove: (child, owner) => child.setParentWindow(owner),
      subscribeFocus: (listener) => {
        const onFocus = () => listener({ window: owner as never, focused: true, visible: true });
        owner.on("focus", onFocus);
        return () => owner.removeListener("focus", onFocus);
      },
    });
    const payload = {
      type: "show" as const,
      state,
      anchor: { x: 240, lineTop: 120, lineBottom: 144 },
      targetId: "composer",
      generation: 4,
    };

    controller.update(owner as never, payload);
    const candidate = shared.windows.at(-1);
    if (!candidate) throw new Error("candidate window was not created");
    controller.markRendererReady();
    candidate.webContents.emit("did-finish-load");

    controller.update(owner as never, {
      ...payload,
      anchor: { x: 248, lineTop: 120, lineBottom: 144 },
    });
    owner.emit("focus");

    expect(
      vi.mocked(logImeDiagnostic).mock.calls.filter(([event]) => event === "candidate-anchor"),
    ).toEqual([
      ["candidate-anchor", expect.objectContaining({ state: "available", x: 240, generation: 4 })],
    ]);
    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "candidate-owner-focus",
      expect.objectContaining({
        hasAnchor: true,
        candidateVisible: true,
        candidateAlwaysOnTop: true,
        focusedWindowId: undefined,
      }),
    );

    controller.update(owner as never, {
      type: "clear",
      targetId: "composer",
      generation: 4,
    });
    expect(logImeDiagnostic).toHaveBeenCalledWith(
      "candidate-anchor",
      expect.objectContaining({ state: "unavailable", reason: "clear" }),
    );
    controller.dispose();
  });

  it("repositions when its owner moves and removes display listeners on dispose", () => {
    const owner = new shared.MockWindow({ x: 100, y: 50, width: 800, height: 600 });
    const controller = createImeCandidateWindowController({
      isOwnerWindow: (candidate) => candidate === owner,
      registerWindowSurface: vi.fn(),
      prepareWindowToShow: () => true,
      attachAbove: (child, owner) => child.setParentWindow(owner),
    });
    controller.update(owner as never, {
      type: "show",
      state,
      anchor: { x: 240, lineTop: 120, lineBottom: 144 },
      targetId: "composer",
      generation: 1,
    });
    const candidate = shared.windows.at(-1);
    if (!candidate) throw new Error("candidate window was not created");

    controller.markRendererReady();
    expect(candidate.visible).toBe(false);
    candidate.webContents.emit("did-finish-load");
    expect(candidate.visible).toBe(true);
    const originalX = candidate.bounds.x;

    owner.bounds = { ...owner.bounds, x: 300 };
    owner.emit("move");
    expect(candidate.bounds.x).toBe(originalX + 200);
    const positionedCount = () =>
      vi
        .mocked(logImeDiagnostic)
        .mock.calls.filter(([event]) => event === "candidate-native-positioned").length;
    const afterMove = positionedCount();
    owner.emit("resize");
    expect(positionedCount()).toBe(afterMove);

    expect(shared.screen.listenerCount("display-metrics-changed")).toBe(1);
    controller.dispose();
    expect(shared.screen.listenerCount("display-metrics-changed")).toBe(0);
    expect(candidate.destroyed).toBe(true);
  });

  it("warms the candidate renderer before the first composition", () => {
    const controller = createImeCandidateWindowController({
      isOwnerWindow: () => true,
      registerWindowSurface: vi.fn(),
      prepareWindowToShow: () => true,
      attachAbove: (child, owner) => child.setParentWindow(owner),
    });

    controller.warmup();
    const candidate = shared.windows.at(-1);
    expect(candidate).toBeDefined();
    expect(candidate?.visible).toBe(false);
    candidate?.webContents.emit("did-finish-load");
    expect(candidate?.visible).toBe(false);
    controller.dispose();
  });

  it("does not clear an active composition when the renderer reports a transient empty state", () => {
    const owner = new shared.MockWindow({ x: 100, y: 50, width: 800, height: 600 });
    const controller = createImeCandidateWindowController({
      isOwnerWindow: (candidate) => candidate === owner,
      registerWindowSurface: vi.fn(),
      prepareWindowToShow: () => true,
      attachAbove: (child, owner) => child.setParentWindow(owner),
    });
    controller.update(owner as never, {
      type: "show",
      state,
      anchor: { x: 240, lineTop: 120, lineBottom: 144 },
      targetId: "composer",
      generation: 1,
    });
    const candidate = shared.windows.at(-1);
    if (!candidate) throw new Error("candidate window was not created");
    controller.markRendererReady();
    candidate.webContents.emit("did-finish-load");

    controller.update(owner as never, {
      type: "clear",
      state: { ...state, preedit: "", candidates: [] },
      targetId: "composer",
      generation: 1,
    });
    expect(candidate.visible).toBe(false);

    controller.update(owner as never, {
      type: "show",
      state,
      anchor: { x: 240, lineTop: 120, lineBottom: 144 },
      targetId: "composer",
      generation: 1,
    });
    expect(candidate.visible).toBe(true);
    controller.dispose();
  });
});
