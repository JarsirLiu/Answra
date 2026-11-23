import { type LiveFrame, type SessionFrame, toSessionItemFrame } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import type { StepStart } from "../../../src/core/session/contracts";
import { SessionFrameBus, toLiveFrame } from "../../../src/core/session/sessionFrameBus";
import { itemOf, TEST_SESSION_ID, TEST_STEP_ID, TEST_TURN_ID } from "./fixtures";

const STEP: StepStart = {
  sessionId: TEST_SESSION_ID,
  turnId: TEST_TURN_ID,
  stepId: TEST_STEP_ID,
  index: 0,
  agentId: "general",
  source: "user",
  messageId: "assistant-1",
};

function durableFrame(): SessionFrame {
  return toSessionItemFrame(
    TEST_SESSION_ID,
    itemOf(1, {
      itemId: "text-1",
      turnId: TEST_TURN_ID,
      messageId: "assistant-1",
      authorAgentId: "general",
      payload: { kind: "text", text: "答" },
    }),
    "test-producer",
  );
}

function liveFrame(): LiveFrame {
  return {
    sessionId: TEST_SESSION_ID,
    messageId: "assistant-1",
    event: { type: "text-delta", partId: "text-1", delta: "a" },
  };
}

describe("SessionFrameBus", () => {
  it("delivers durable frames until the subscriber unsubscribes", () => {
    const bus = new SessionFrameBus();
    const frames: SessionFrame[] = [];
    const unsubscribe = bus.subscribe({ onFrame: (frame) => frames.push(frame) });

    bus.publish(durableFrame());
    unsubscribe();
    bus.publish(durableFrame());

    expect(frames).toHaveLength(1);
    expect(frames[0]?.event.type).toBe("session-item");
  });

  it("keeps durable and live channels separate", () => {
    const bus = new SessionFrameBus();
    const durable: SessionFrame[] = [];
    const live: LiveFrame[] = [];
    bus.subscribe({
      onFrame: (frame) => durable.push(frame),
      onLiveFrame: (frame) => live.push(frame),
    });

    bus.publish(durableFrame());
    bus.publishLive(liveFrame());

    expect(durable.map((frame) => frame.event.type)).toEqual(["session-item"]);
    expect(live.map((frame) => frame.event.type)).toEqual(["text-delta"]);
  });

  it("does not replay history to late subscribers", () => {
    const bus = new SessionFrameBus();
    bus.publish(durableFrame());

    const late = vi.fn();
    bus.subscribe({ onFrame: late });

    expect(late).not.toHaveBeenCalled();
  });

  it("isolates a throwing subscriber from the write path and other subscribers", () => {
    const onListenerError = vi.fn();
    const bus = new SessionFrameBus({ onListenerError });
    const received: SessionFrame[] = [];
    bus.subscribe({
      onFrame: () => {
        throw new Error("subscriber failed");
      },
    });
    bus.subscribe({ onFrame: (frame) => received.push(frame) });

    expect(() => bus.publish(durableFrame())).not.toThrow();
    expect(received).toHaveLength(1);
    expect(onListenerError).toHaveBeenCalledOnce();
  });
});

describe("toLiveFrame", () => {
  it("builds a live frame from a step and a delta", () => {
    expect(toLiveFrame(STEP, { type: "text-delta", partId: "text-1", delta: "answer" })).toEqual({
      sessionId: TEST_SESSION_ID,
      messageId: "assistant-1",
      stepId: TEST_STEP_ID,
      event: { type: "text-delta", partId: "text-1", delta: "answer" },
    });
  });

  it("rejects durable facts so they cannot bypass the journal", () => {
    expect(toLiveFrame(STEP, { type: "text-start", partId: "text-1" })).toBeUndefined();
    expect(toLiveFrame(STEP, { type: "finish", finishReason: "stop" })).toBeUndefined();
  });
});
