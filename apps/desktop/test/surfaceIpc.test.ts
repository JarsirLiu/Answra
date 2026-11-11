import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  showSurface: vi.fn(() => ({ shown: true })),
  sendSurfaceState: vi.fn(),
  dismissSurface: vi.fn(),
  handleSurfaceAction: vi.fn(),
  resizeSurfaceWindow: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = listener;
    },
  },
}));

vi.mock("../src/main/window", () => ({
  getWindow: () => ({ webContents: { id: "main" } }),
  isWindowFromSender: (_window: unknown, event: { sender: string }) => event.sender === "main",
  isSurfaceWindowFromSender: (event: { sender: string }) => event.sender === "surface",
  showSurface: shared.showSurface,
  sendSurfaceState: shared.sendSurfaceState,
  dismissSurface: shared.dismissSurface,
  handleSurfaceAction: shared.handleSurfaceAction,
  resizeSurfaceWindow: shared.resizeSurfaceWindow,
}));

import { SurfaceChannels, SurfacePresetIds } from "@answra/shared";
import { registerSurfaceIpc } from "../src/main/surface/surfaceIpc";

describe("surface IPC", () => {
  beforeEach(() => {
    shared.handlers = {};
    shared.showSurface.mockClear();
    shared.sendSurfaceState.mockClear();
    shared.dismissSurface.mockClear();
    shared.handleSurfaceAction.mockClear();
    shared.resizeSurfaceWindow.mockClear();
    registerSurfaceIpc();
  });

  it("accepts show requests only from the main renderer and only for known presets", () => {
    expect(
      shared.handlers[SurfaceChannels.Show](
        { sender: "main" },
        { presetId: SurfacePresetIds.InterviewClearConfirm },
      ),
    ).toEqual({ shown: true });
    expect(shared.showSurface).toHaveBeenCalledWith(SurfacePresetIds.InterviewClearConfirm);

    expect(() =>
      shared.handlers[SurfaceChannels.Show](
        { sender: "surface" },
        { presetId: SurfacePresetIds.InterviewClearConfirm },
      ),
    ).toThrow("非法调用");
    expect(
      shared.handlers[SurfaceChannels.Show]({ sender: "main" }, { presetId: "unknown" }),
    ).toEqual({ shown: false });
    expect(shared.showSurface).toHaveBeenCalledTimes(1);
  });

  it("accepts actions and sizes only from the surface renderer", () => {
    shared.handlers[SurfaceChannels.Action]({ sender: "surface" }, { actionId: "confirm" });
    shared.handlers[SurfaceChannels.Action]({ sender: "main" }, { actionId: "confirm" });
    shared.handlers[SurfaceChannels.Action]({ sender: "surface" }, { actionId: "" });
    expect(shared.handleSurfaceAction).toHaveBeenCalledOnce();
    expect(shared.handleSurfaceAction).toHaveBeenCalledWith("confirm");

    shared.handlers[SurfaceChannels.Fit]({ sender: "surface" }, { width: 320, height: 120 });
    shared.handlers[SurfaceChannels.Fit]({ sender: "main" }, { width: 320, height: 120 });
    shared.handlers[SurfaceChannels.Fit]({ sender: "surface" }, { width: 0, height: 120 });
    expect(shared.resizeSurfaceWindow).toHaveBeenCalledOnce();
    expect(shared.resizeSurfaceWindow).toHaveBeenCalledWith({ width: 320, height: 120 });
  });

  it("routes ready and dismiss only from the surface renderer", () => {
    shared.handlers[SurfaceChannels.Ready]({ sender: "surface" });
    shared.handlers[SurfaceChannels.Ready]({ sender: "main" });
    shared.handlers[SurfaceChannels.Dismiss]({ sender: "surface" });
    shared.handlers[SurfaceChannels.Dismiss]({ sender: "main" });

    expect(shared.sendSurfaceState).toHaveBeenCalledOnce();
    expect(shared.dismissSurface).toHaveBeenCalledOnce();
  });
});
