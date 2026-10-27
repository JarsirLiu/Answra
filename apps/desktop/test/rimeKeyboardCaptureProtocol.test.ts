import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));

import { parseKeyboardCaptureEvent } from "../src/main/ime/rimeBridge";

function event(key: string) {
  return JSON.stringify({
    generation: 1,
    eventId: 7,
    key,
    code: key,
    shift: false,
    ctrl: false,
    alt: false,
    meta: false,
    release: false,
    repeat: false,
  });
}

describe("rime keyboard capture protocol", () => {
  it("accepts named editing keys longer than eight characters", () => {
    expect(parseKeyboardCaptureEvent(event("Backspace"))?.type).toBe("key");
    expect(parseKeyboardCaptureEvent(event("ArrowLeft"))?.type).toBe("key");
    expect(parseKeyboardCaptureEvent(event("ArrowRight"))?.type).toBe("key");
  });

  it("still rejects an unbounded key name", () => {
    expect(parseKeyboardCaptureEvent(event("x".repeat(33)))).toBeUndefined();
  });
});
