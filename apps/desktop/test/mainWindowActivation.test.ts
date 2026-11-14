import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { activateMainWindow } from "../src/main/mainWindowActivation";

function createWindow(options: { visible?: boolean; destroyed?: boolean } = {}) {
  return {
    id: 7,
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    isVisible: vi.fn(() => options.visible ?? true),
    showInactive: vi.fn(),
    focus: vi.fn(),
  } as unknown as BrowserWindow & {
    showInactive: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
}

describe("main window activation", () => {
  it("recreates the window when the previous one is gone", () => {
    const createWindowSpy = vi.fn();
    activateMainWindow({
      getWindow: () => undefined,
      prepareWindowToShow: () => true,
      createWindow: createWindowSpy,
    });

    expect(createWindowSpy).toHaveBeenCalledOnce();
  });

  it("recreates the window when the tracked window is already destroyed", () => {
    const createWindowSpy = vi.fn();
    activateMainWindow({
      getWindow: () => createWindow({ destroyed: true }),
      prepareWindowToShow: () => true,
      createWindow: createWindowSpy,
    });

    expect(createWindowSpy).toHaveBeenCalledOnce();
  });

  it("shows a hidden window before focusing it", () => {
    const window = createWindow({ visible: false });
    activateMainWindow({
      getWindow: () => window,
      prepareWindowToShow: () => true,
      createWindow: vi.fn(),
    });

    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("focuses a visible window without showing it again", () => {
    const window = createWindow({ visible: true });
    activateMainWindow({
      getWindow: () => window,
      prepareWindowToShow: () => true,
      createWindow: vi.fn(),
    });

    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("leaves the window hidden when the window policy rejects showing", () => {
    const window = createWindow({ visible: false });
    const log = vi.fn();
    activateMainWindow({
      getWindow: () => window,
      prepareWindowToShow: () => false,
      createWindow: vi.fn(),
      log,
    });

    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });
});
