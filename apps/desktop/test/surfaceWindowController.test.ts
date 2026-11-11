import { SurfaceChannels, type SurfaceSpec } from "@answra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeWindow = ReturnType<typeof createWindow>;

const mocks = vi.hoisted(() => ({
  created: undefined as FakeWindow | undefined,
  primaryWorkArea: { x: 0, y: 0, width: 800, height: 600 },
  displayWorkArea: { x: 0, y: 0, width: 800, height: 600 },
  moveListener: undefined as (() => void) | undefined,
  readyListener: undefined as (() => void) | undefined,
  closedListener: undefined as (() => void) | undefined,
}));

vi.mock("electron", () => ({
  app: { isPackaged: true },
  BrowserWindow: vi.fn(function (this: object) {
    return mocks.created ?? this;
  }),
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workArea: mocks.primaryWorkArea })),
    getDisplayMatching: vi.fn(() => ({ workArea: mocks.displayWorkArea })),
  },
}));

import {
  createSurfaceWindowController,
  type SurfaceWindowControllerHost,
} from "../src/main/surface/surfaceWindowController";

const spec: SurfaceSpec = {
  schemaVersion: 1,
  id: "test-surface",
  revision: 1,
  producer: "product",
  title: "Test",
  root: { type: "text", text: "hello" },
  window: { width: 340, draggable: true, dismissible: true },
  lifecycle: { kind: "ephemeral" },
};

function createWindow() {
  let bounds = { x: 100, y: 100, width: 340, height: 180 };
  let visible = false;
  return {
    id: 1,
    getBounds: vi.fn(() => bounds),
    hide: vi.fn(() => {
      visible = false;
    }),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => visible),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "move") mocks.moveListener = listener;
      if (event === "closed") mocks.closedListener = listener;
    }),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "ready-to-show") mocks.readyListener = listener;
    }),
    setBounds: vi.fn((next: typeof bounds) => {
      bounds = next;
    }),
    setPosition: vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    }),
    setSkipTaskbar: vi.fn(),
    showInactive: vi.fn(() => {
      visible = true;
    }),
    webContents: {
      id: "surface",
      on: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };
}

function createHost(): SurfaceWindowControllerHost {
  return {
    registerWindowSurface: vi.fn(),
    prepareWindowToShow: vi.fn(() => true),
    isStealthEnabled: vi.fn(() => false),
    readPosition: vi.fn(() => undefined),
    writePosition: vi.fn(),
  };
}

describe("surface window lifecycle", () => {
  beforeEach(() => {
    mocks.created = createWindow();
    mocks.moveListener = undefined;
    mocks.readyListener = undefined;
    mocks.closedListener = undefined;
  });

  it("registers the surface role and shows only after renderer and ready-to-show handshakes", () => {
    const host = createHost();
    const controller = createSurfaceWindowController(host);

    controller.show(spec);

    expect(host.registerWindowSurface).toHaveBeenCalledWith(
      mocks.created,
      expect.objectContaining({ role: "surface", captureProtection: "stealth-only" }),
    );
    expect(mocks.created?.loadFile).toHaveBeenCalledWith(expect.stringContaining("index.html"), {
      query: { surface: "surface" },
    });

    controller.handleReady();
    expect(mocks.created?.showInactive).not.toHaveBeenCalled();

    mocks.readyListener?.();
    expect(mocks.created?.webContents).toMatchObject({
      send: expect.any(Function),
    });
    expect(mocks.created?.webContents.send).toHaveBeenCalledWith(SurfaceChannels.State, {
      spec,
      stealth: false,
    });
    expect(mocks.created?.showInactive).toHaveBeenCalledOnce();
  });

  it("clamps a renderer-reported size to the work area and updates the window", () => {
    const host = createHost();
    const controller = createSurfaceWindowController(host);
    controller.show(spec);

    controller.resize({ width: 600, height: 1000 });

    expect(mocks.created?.setBounds).toHaveBeenCalledWith(
      { x: 100, y: 24, width: 560, height: 576 },
      false,
    );
  });

  it("dismisses by hiding the window and persists the last position", () => {
    const host = createHost();
    const controller = createSurfaceWindowController(host);
    controller.show(spec);
    mocks.readyListener?.();
    controller.handleReady();

    controller.dismiss();

    expect(mocks.created?.hide).toHaveBeenCalledOnce();
    expect(controller.getState()).toBeUndefined();
    expect(host.writePosition).toHaveBeenCalledWith({ x: 230, y: 210 });
  });

  it("accepts IPC only from the surface renderer", () => {
    const host = createHost();
    const controller = createSurfaceWindowController(host);
    controller.show(spec);

    expect(controller.isFromSender({ sender: mocks.created?.webContents } as never)).toBe(true);
    expect(controller.isFromSender({ sender: { id: "main" } } as never)).toBe(false);
  });
});
