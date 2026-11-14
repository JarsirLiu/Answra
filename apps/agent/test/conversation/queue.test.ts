import { describe, expect, it } from "vitest";
import { ConversationQueue } from "../../src/conversation/queue/conversationQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("ConversationQueue", () => {
  it("starts queued messages in FIFO order after the full run completes", async () => {
    const queue = new ConversationQueue();
    const firstDone = deferred<"completed">();
    const secondDone = deferred<"completed">();
    const started: string[] = [];
    const first = await queue.enqueue(async () => {
      started.push("first");
      return {
        runId: "run-1",
        snapshot: { conversationId: "conversation-1", eventRevision: 1, messages: [] },
        completion: firstDone.promise,
      };
    });
    const second = await queue.enqueue(async () => {
      started.push("second");
      return {
        runId: "run-2",
        snapshot: { conversationId: "conversation-1", eventRevision: 2, messages: [] },
        completion: secondDone.promise,
      };
    });

    expect(first.status).toBe("started");
    expect(second).toMatchObject({ status: "queued", position: 1 });
    expect(started).toEqual(["first"]);

    firstDone.resolve("completed");
    const secondStarted = await queue.waitForStart(second.queueId);
    expect(secondStarted.runId).toBe("run-2");
    expect(started).toEqual(["first", "second"]);

    secondDone.resolve("completed");
    await expect(queue.wait(second.queueId)).resolves.toMatchObject({ outcome: "completed" });
  });

  it("aborts pending messages without cancelling the active run", async () => {
    const queue = new ConversationQueue();
    const activeDone = deferred<"completed">();
    await queue.enqueue(async () => ({
      runId: "run-1",
      snapshot: { conversationId: "conversation-1", eventRevision: 1, messages: [] },
      completion: activeDone.promise,
    }));
    const pending = await queue.enqueue(async () => {
      throw new Error("must not start");
    });

    queue.cancelPending();
    await expect(queue.wait(pending.queueId)).resolves.toMatchObject({ outcome: "aborted" });
    expect(queue.activeQueueId).toBe(firstQueueId(queue));
    activeDone.resolve("completed");
  });

  it("preserves a failed run error for the owning application", async () => {
    const queue = new ConversationQueue();
    const failed = Promise.reject(new Error("handoff target is not visible"));
    const accepted = await queue.enqueue(async () => ({
      runId: "run-1",
      snapshot: { conversationId: "conversation-1", eventRevision: 1, messages: [] },
      completion: failed,
    }));

    const completion = await queue.wait(accepted.queueId);
    expect(completion.outcome).toBe("failed");
    expect(completion.failure?.error).toEqual(new Error("handoff target is not visible"));
  });
});

function firstQueueId(queue: ConversationQueue): string {
  if (!queue.activeQueueId) throw new Error("active queue missing");
  return queue.activeQueueId;
}
