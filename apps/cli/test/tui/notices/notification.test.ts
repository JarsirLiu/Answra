import { describe, expect, it } from "vitest";
import {
  addNotification,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
  EMPTY_NOTIFICATION_STATE,
  notificationTimeoutMs,
  promoteNext,
  removeNotification,
  type TuiNotification,
} from "../../../src/tui/notices/notification";

function note(key: string, priority?: TuiNotification["priority"]): TuiNotification {
  return { key, text: key, ...(priority === undefined ? {} : { priority }) };
}

describe("notification queue", () => {
  it("shows the first notification immediately and queues the next", () => {
    const first = addNotification(EMPTY_NOTIFICATION_STATE, note("first"));
    const second = addNotification(first, note("second"));

    expect(second.current?.text).toBe("first");
    expect(second.queue.map((item) => item.text)).toEqual(["second"]);
  });

  it("replaces a notification with the same key instead of stacking it", () => {
    const first = addNotification(EMPTY_NOTIFICATION_STATE, note("model"));
    const updated = addNotification(first, { key: "model", text: "updated" });

    expect(updated.current?.text).toBe("updated");
    expect(updated.queue).toHaveLength(0);
  });

  it("preempts the current notification for immediate priority", () => {
    const first = addNotification(EMPTY_NOTIFICATION_STATE, note("background"));
    const urgent = addNotification(first, note("urgent", "immediate"));

    expect(urgent.current?.text).toBe("urgent");
    expect(urgent.queue.map((item) => item.text)).toEqual(["background"]);
  });

  it("promotes the highest priority queued notification first", () => {
    const low = addNotification(EMPTY_NOTIFICATION_STATE, note("current"));
    const withLow = addNotification(low, note("low", "low"));
    const withHigh = addNotification(withLow, note("high", "high"));

    expect(withHigh.queue.map((item) => item.text)).toEqual(["low", "high"]);
    expect(promoteNext({ current: null, queue: withHigh.queue }).current?.text).toBe("high");
  });

  it("removes a queued notification without touching the current one", () => {
    const first = addNotification(EMPTY_NOTIFICATION_STATE, note("current"));
    const second = addNotification(first, note("queued"));
    const next = removeNotification(second, "queued");

    expect(next.current?.text).toBe("current");
    expect(next.queue).toHaveLength(0);
  });

  it("removes the current notification and promotes the next", () => {
    const first = addNotification(EMPTY_NOTIFICATION_STATE, note("current"));
    const second = addNotification(first, note("next"));
    const next = removeNotification(second, "current");

    expect(next.current?.text).toBe("next");
    expect(next.queue).toHaveLength(0);
  });

  it("uses the Claude Code default timeout unless one is provided", () => {
    expect(notificationTimeoutMs(note("default"))).toBe(DEFAULT_NOTIFICATION_TIMEOUT_MS);
    expect(notificationTimeoutMs({ key: "short", text: "short", timeoutMs: 2_000 })).toBe(2_000);
    expect(notificationTimeoutMs({ key: "sticky", text: "sticky", timeoutMs: null })).toBeNull();
  });
});
