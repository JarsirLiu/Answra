import { describe, expect, it } from "vitest";
import { TurnQueueRegistry } from "../../../src/core/queue/turnQueueRegistry";

function snapshot(revision: number) {
  return { conversationId: "conversation-1", eventRevision: revision, messages: [] };
}

describe("TurnQueueRegistry", () => {
  it("keeps the last run association after a run leaves the active map", async () => {
    const registry = new TurnQueueRegistry();
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await registry.enqueue("conversation-1", async () => ({
      runId: "run-1",
      snapshot: snapshot(1),
      completion: active.then(() => "completed" as const),
    }));
    expect(first.status).toBe("started");
    registry.trackRun("conversation-1", "run-1");
    registry.untrackRun("run-1");

    expect(registry.conversationForRun("run-1")).toBe("conversation-1");
    expect(registry.activeRunId("conversation-1")).toBe("run-1");
    release();
    registry.dispose();
  });

  it("tracks queued count and position per conversation", async () => {
    const registry = new TurnQueueRegistry();
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    await registry.enqueue("conversation-1", async () => ({
      runId: "run-1",
      snapshot: snapshot(1),
      completion: active.then(() => "completed" as const),
    }));
    const queued = await registry.enqueue("conversation-1", async () => ({
      runId: "run-2",
      snapshot: snapshot(2),
      completion: Promise.resolve("completed" as const),
    }));

    expect(registry.hasQueued("conversation-1")).toBe(true);
    expect(registry.queuedCount("conversation-1")).toBe(1);
    expect(registry.position("conversation-1", queued.queueId)).toBe(1);

    registry.cancelPending("conversation-1");
    expect(registry.queuedCount("conversation-1")).toBe(0);
    expect(registry.position("conversation-1", queued.queueId)).toBeUndefined();
    release();
    registry.dispose();
  });
});
