import { describe, expect, it, vi } from "vitest";
import { createWindowSurfaceRegistry } from "../src/main/windowSurfaceRegistry";

class MockWindow {
  static nextId = 1;
  readonly id = MockWindow.nextId++;
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  destroyed = false;
  visible = false;
  parent: MockWindow | null = null;
  hide = vi.fn(() => {
    this.visible = false;
  });
  setAlwaysOnTop = vi.fn();
  setFocusable = vi.fn();
  setParentWindow = vi.fn((parent: MockWindow | null) => {
    this.parent = parent;
  });
  getMediaSourceId = vi.fn(() => `window:${this.id}`);
  moveAbove = vi.fn();
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void) {
    const onceListener = (...args: unknown[]) => {
      this.removeListener(event, onceListener);
      listener(...args);
    };
    return this.on(event, onceListener);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

describe("window surface registry", () => {
  it("applies role policies and centralizes native focus events", () => {
    const applyCaptureProtection = vi.fn(() => true);
    const registry = createWindowSurfaceRegistry({
      applyCaptureProtection,
      platform: "win32",
    });
    const main = new MockWindow();
    const candidate = new MockWindow();
    const focusEvents: unknown[] = [];
    registry.register(main as never, { role: "main", captureProtection: "stealth-only" });
    registry.register(candidate as never, {
      role: "ime-candidate",
      captureProtection: "stealth-only",
    });

    expect(main.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
    expect(main.setFocusable).toHaveBeenCalledWith(false);
    expect(candidate.setAlwaysOnTop).toHaveBeenCalledWith(true, "pop-up-menu");
    expect(candidate.setFocusable).toHaveBeenCalledWith(false);
    expect(applyCaptureProtection).toHaveBeenLastCalledWith(candidate, false);

    const unsubscribe = registry.subscribeFocus((event) => focusEvents.push(event));
    main.emit("focus");
    expect(registry.focusedWindow).toBe(main);
    expect(focusEvents).toEqual([{ window: main, focused: true, visible: false }]);
    unsubscribe();
    main.emit("blur");
    expect(focusEvents).toHaveLength(1);

    registry.setStealthEnabled(true);
    expect(applyCaptureProtection).toHaveBeenLastCalledWith(candidate, true);
  });

  it("keeps the main surface focusable on platforms without the non-activating policy", () => {
    const registry = createWindowSurfaceRegistry({
      applyCaptureProtection: () => true,
      platform: "darwin",
    });
    const main = new MockWindow();

    registry.register(main as never, { role: "main", captureProtection: "never" });

    expect(main.setFocusable).not.toHaveBeenCalled();
  });

  it("reconciles the candidate owner relationship on owner focus and cleans it up", () => {
    const registry = createWindowSurfaceRegistry({
      applyCaptureProtection: () => true,
      platform: "win32",
    });
    const main = new MockWindow();
    const reply = new MockWindow();
    const candidate = new MockWindow();
    registry.register(main as never, { role: "main", captureProtection: "never" });
    registry.register(reply as never, { role: "reply-bar", captureProtection: "never" });
    registry.register(candidate as never, {
      role: "ime-candidate",
      captureProtection: "never",
    });

    registry.attachAbove(candidate as never, reply as never);
    expect(candidate.parent).toBe(reply);
    expect(candidate.moveAbove).toHaveBeenCalledWith(`window:${reply.id}`);
    const callsBeforeFocus = candidate.setParentWindow.mock.calls.length;
    reply.emit("focus");
    expect(candidate.setParentWindow).toHaveBeenCalledTimes(callsBeforeFocus + 1);
    expect(candidate.setAlwaysOnTop).toHaveBeenLastCalledWith(true, "pop-up-menu");

    registry.attachAbove(candidate as never, main as never);
    expect(candidate.parent).toBe(main);
    expect(() => registry.attachAbove(main as never, candidate as never)).toThrow(
      /Only an IME candidate surface/,
    );
    registry.unregister(main as never);
    expect(candidate.parent).toBeNull();
  });

  it("fails closed before showing a protected surface and unregisters listeners", () => {
    const window = new MockWindow();
    const onPolicyFailure = vi.fn();
    const registry = createWindowSurfaceRegistry({
      applyCaptureProtection: () => false,
      onPolicyFailure,
      platform: "win32",
    });
    registry.setStealthEnabled(true);
    registry.register(window as never, {
      role: "ime-candidate",
      captureProtection: "stealth-only",
      failClosed: true,
    });

    expect(registry.prepareToShow(window as never)).toBe(false);
    expect(window.hide).toHaveBeenCalled();
    expect(onPolicyFailure).toHaveBeenCalledWith(window, "ime-candidate");
    expect(registry.size).toBe(1);

    window.destroyed = true;
    window.emit("closed");
    expect(registry.size).toBe(0);
    expect(window.listeners.get("focus")?.size).toBe(0);
    expect(window.listeners.get("blur")?.size).toBe(0);
    expect(window.listeners.get("show")?.size).toBe(0);
  });

  it("applies capture protection without changing z-order during an opacity-shield show", () => {
    const applyCaptureProtection = vi.fn(() => true);
    const registry = createWindowSurfaceRegistry({
      applyCaptureProtection,
      platform: "win32",
    });
    const window = new MockWindow();
    registry.setStealthEnabled(true);
    registry.register(window as never, {
      role: "selection-overlay",
      captureProtection: "stealth-only",
      failClosed: true,
    });
    window.setAlwaysOnTop.mockClear();
    applyCaptureProtection.mockClear();

    expect(registry.prepareCaptureProtection(window as never)).toBe(true);

    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(applyCaptureProtection).toHaveBeenCalledWith(window, true);
  });

  it("does not reapply selection overlay HWND policy from the show event", () => {
    const applyCaptureProtection = vi.fn(() => true);
    const registry = createWindowSurfaceRegistry({
      applyCaptureProtection,
      platform: "win32",
    });
    const window = new MockWindow();
    registry.setStealthEnabled(true);
    registry.register(window as never, {
      role: "selection-overlay",
      captureProtection: "stealth-only",
      failClosed: true,
    });
    window.setAlwaysOnTop.mockClear();
    window.setFocusable.mockClear();
    applyCaptureProtection.mockClear();

    window.emit("show");

    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(window.setFocusable).not.toHaveBeenCalled();
    expect(applyCaptureProtection).not.toHaveBeenCalled();
    expect(registry.prepareCaptureProtection(window as never)).toBe(true);
    expect(applyCaptureProtection).toHaveBeenCalledWith(window, true);
  });

  it("rejects duplicate registration for the same native window", () => {
    const registry = createWindowSurfaceRegistry({
      applyCaptureProtection: () => true,
      platform: "win32",
    });
    const window = new MockWindow();
    const descriptor = { role: "main" as const, captureProtection: "stealth-only" as const };
    registry.register(window as never, descriptor);

    expect(() => registry.register(window as never, descriptor)).toThrow(/already registered/);
  });
});
