import { describe, expect, it, vi } from "vitest";
import { createWindowPolicyRegistry } from "../src/main/windowPolicyRegistry";

class MockWindow {
  readonly id = 1;
  readonly listeners = new Map<string, Set<() => void>>();
  destroyed = false;
  hide = vi.fn();
  isDestroyed = () => this.destroyed;

  on(event: string, listener: () => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: () => void) {
    const onceListener = () => {
      this.removeListener(event, onceListener);
      listener();
    };
    return this.on(event, onceListener);
  }

  removeListener(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

describe("window policy registry", () => {
  it("does not allow an unregistered window to pass the show guard", () => {
    const registry = createWindowPolicyRegistry({ applyCaptureProtection: () => true });
    expect(registry.prepareToShow(new MockWindow() as never)).toBe(false);
  });

  it("applies current stealth state before showing and refreshes on restore", () => {
    const applyCaptureProtection = vi.fn(() => true);
    const registry = createWindowPolicyRegistry({ applyCaptureProtection });
    const window = new MockWindow();

    registry.setStealthEnabled(true);
    registry.register(window as never, {
      role: "reply-bar",
      captureProtection: "stealth-only",
    });
    expect(applyCaptureProtection).toHaveBeenLastCalledWith(window, true);
    expect(registry.prepareToShow(window as never)).toBe(true);
    window.emit("restore");
    expect(applyCaptureProtection).toHaveBeenCalledTimes(3);

    registry.setStealthEnabled(false);
    expect(applyCaptureProtection).toHaveBeenLastCalledWith(window, false);
  });

  it("fails closed for a protected surface and unregisters listeners on close", () => {
    const window = new MockWindow();
    const onPolicyFailure = vi.fn();
    const registry = createWindowPolicyRegistry({
      applyCaptureProtection: () => false,
      onPolicyFailure,
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
    expect(window.listeners.get("show")?.size).toBe(0);
    expect(window.listeners.get("resize")?.size).toBe(0);
    expect(window.listeners.get("restore")?.size).toBe(0);
  });

  it("rejects duplicate registration for the same native window", () => {
    const registry = createWindowPolicyRegistry({ applyCaptureProtection: () => true });
    const window = new MockWindow();
    const descriptor = { role: "main" as const, captureProtection: "stealth-only" as const };
    registry.register(window as never, descriptor);

    expect(() => registry.register(window as never, descriptor)).toThrow(/already registered/);
  });
});
