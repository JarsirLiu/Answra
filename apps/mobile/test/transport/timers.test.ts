import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMobileSignalingTimers } from "../../src/transport/timers";

describe("mobile signaling timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the callback only after the requested delay", () => {
    const timers = createMobileSignalingTimers();
    const callback = vi.fn();

    timers.after(50, callback);
    vi.advanceTimersByTime(49);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cancels a scheduled callback", () => {
    const timers = createMobileSignalingTimers();
    const callback = vi.fn();

    const cancel = timers.after(50, callback);
    cancel();
    vi.advanceTimersByTime(50);

    expect(callback).not.toHaveBeenCalled();
  });
});
