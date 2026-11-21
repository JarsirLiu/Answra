import { describe, expect, it } from "vitest";
import { TurnQueue } from "../../../src/core/queue/turnQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("TurnQueue", () => {
  it("starts queued turns in FIFO order after the active turn completes", async () => {
    const queue = new TurnQueue();
    const firstDone = deferred<"completed">();
    const secondDone = deferred<"completed">();
    const started: string[] = [];
    const first = await queue.enqueue(async () => {
      started.push("first");
      return {
        runId: "run-1",
        snapshot: snapshot(1),
        completion: firstDone.promise,
      };
    });
    const second = await queue.enqueue(async () => {
      started.push("second");
      return {
        runId: "run-2",
        snapshot: snapshot(2),
        completion: secondDone.promise,
      };
    });

    expect(first.status).toBe("started");
    expect(second).toMatchObject({ status: "queued", position: 1 });
    expect(queue.position(second.queueId)).toBe(1);
    expect(started).toEqual(["first"]);

    firstDone.resolve("completed");
    const secondStarted = await queue.waitForStart(second.queueId);
    expect(secondStarted.runId).toBe("run-2");
    expect(started).toEqual(["first", "second"]);
    expect(queue.position(second.queueId)).toBeUndefined();

    secondDone.resolve("completed");
    await expect(queue.wait(second.queueId)).resolves.toMatchObject({ outcome: "completed" });
  });

  it("aborts pending turns without cancelling the active turn", async () => {
    const queue = new TurnQueue();
    const activeDone = deferred<"completed">();
    await queue.enqueue(async () => ({
      runId: "run-1",
      snapshot: snapshot(1),
      completion: activeDone.promise,
    }));
    const pending = await queue.enqueue(async () => {
      throw new Error("must not start");
    });

    queue.cancelPending();
    await expect(queue.wait(pending.queueId)).resolves.toMatchObject({ outcome: "aborted" });
    expect(queue.position(pending.queueId)).toBeUndefined();
    expect(queue.activeQueueId).toBe("turn-queue-1");
    activeDone.resolve("completed");
  });

  it("preserves a failed turn error for the owning application", async () => {
    const queue = new TurnQueue();
    const failed = Promise.reject(new Error("handoff target is not visible"));
    const accepted = await queue.enqueue(async () => ({
      runId: "run-1",
      snapshot: snapshot(1),
      completion: failed,
    }));

    const completion = await queue.wait(accepted.queueId);
    expect(completion.outcome).toBe("failed");
    expect(completion.failure?.error).toEqual(new Error("handoff target is not visible"));
  });

  it("does not start pending turns after disposal", async () => {
    const queue = new TurnQueue();
    const activeDone = deferred<"completed">();
    await queue.enqueue(async () => ({
      runId: "run-1",
      snapshot: snapshot(1),
      completion: activeDone.promise,
    }));
    let started = false;
    const pending = await queue.enqueue(async () => {
      started = true;
      return {
        runId: "run-2",
        snapshot: snapshot(2),
        completion: Promise.resolve("completed" as const),
      };
    });

    const completion = queue.wait(pending.queueId);
    queue.dispose();
    activeDone.resolve("completed");

    await expect(completion).resolves.toMatchObject({ outcome: "aborted" });
    expect(started).toBe(false);
  });
});

function snapshot(revision: number) {
  return { conversationId: "conversation-1", eventRevision: revision, messages: [] };
}
