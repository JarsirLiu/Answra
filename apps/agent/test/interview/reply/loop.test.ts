import { describe, expect, it, vi } from "vitest";
import {
  type CommittedInterviewTurn,
  conversationId,
  sessionId,
  turnId,
} from "../../../src/interview/contracts";
import { InterviewReplyLoop } from "../../../src/interview/reply/loop";

function turn(id = "u1"): CommittedInterviewTurn {
  return {
    sessionId: sessionId("session-1"),
    conversationId: conversationId("conversation-1"),
    turnId: turnId(`session-1:${id}`),
    version: 0,
    status: "committed",
    chunks: [],
    missingChunkIndexes: [],
  };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createHarness() {
  const appendUserTurn = vi.fn(async () => undefined);
  const cancelReply = vi.fn();
  const onError = vi.fn();
  const replies = new Map<string, ReturnType<typeof deferred>>();
  let sequence = 0;
  let startGate: ReturnType<typeof deferred> | undefined;
  const startReply = vi.fn(async () => {
    const gate = startGate;
    startGate = undefined;
    if (gate) await gate.promise;
    sequence += 1;
    const runId = `run-${sequence}`;
    replies.set(runId, deferred());
    return { runId };
  });
  const waitForReply = vi.fn((runId: string) => replies.get(runId)?.promise ?? Promise.resolve());
  const loop = new InterviewReplyLoop({
    source: "candidate",
    ports: { appendUserTurn, startReply, cancelReply, waitForReply, onError },
  });
  return {
    loop,
    appendUserTurn,
    startReply,
    cancelReply,
    waitForReply,
    onError,
    finish: (runId?: string) => {
      const id = runId ?? `run-${sequence}`;
      replies.get(id)?.resolve();
    },
    holdNextStart: () => {
      const gate = deferred();
      startGate = gate;
      return gate;
    },
  };
}

describe("interview reply loop", () => {
  it("appends the settled turn before starting the reply", async () => {
    const harness = createHarness();

    await harness.loop.turnSettled("conversation-1", [turn()], "请自我介绍");

    expect(harness.appendUserTurn).toHaveBeenCalledWith(
      "conversation-1",
      [expect.objectContaining({ turnId: "session-1:u1" })],
      "请自我介绍",
    );
    expect(harness.startReply).toHaveBeenCalledTimes(1);
    expect(harness.appendUserTurn.mock.invocationCallOrder[0]).toBeLessThan(
      harness.startReply.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("cancels the active reply when the trigger source speaks again", async () => {
    const harness = createHarness();
    await harness.loop.turnSettled("conversation-1", [turn("u1")], "第一句");

    harness.loop.speechStarted("candidate");

    expect(harness.cancelReply).toHaveBeenCalledWith("run-1");
  });

  it("cancels a reply whose run starts after the trigger source spoke during token acquisition", async () => {
    const harness = createHarness();
    const gate = harness.holdNextStart();
    const settled = harness.loop.turnSettled("conversation-1", [turn("u1")], "第一句");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.startReply).toHaveBeenCalledTimes(1);
    harness.loop.speechStarted("candidate");
    gate.resolve();
    await settled;

    expect(harness.cancelReply).toHaveBeenCalledWith("run-1");
    harness.finish("run-1");
  });

  it("keeps the reply when the trigger source spoke before its turn settled", async () => {
    const harness = createHarness();

    harness.loop.speechStarted("candidate");
    await harness.loop.turnSettled("conversation-1", [turn("u1")], "第一句");

    expect(harness.startReply).toHaveBeenCalledTimes(1);
    expect(harness.cancelReply).not.toHaveBeenCalled();
    harness.finish("run-1");
  });

  it("does not reply to a turn superseded while its user message is being appended", async () => {
    const harness = createHarness();
    const gate = deferred();
    harness.appendUserTurn.mockImplementationOnce(async () => {
      await gate.promise;
    });

    const settled = harness.loop.turnSettled("conversation-1", [turn("u1")], "第一句");
    await new Promise<void>((resolve) => setImmediate(resolve));
    harness.loop.speechStarted("candidate");
    gate.resolve();
    await settled;

    expect(harness.startReply).not.toHaveBeenCalled();
  });

  it("does not start a queued turn from a previous session after a new session starts", async () => {
    const harness = createHarness();
    const gate = deferred();
    harness.appendUserTurn.mockImplementationOnce(async () => {
      await gate.promise;
    });

    const settled = harness.loop.turnSettled("conversation-1", [turn("u1")], "第一句");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopped = harness.loop.stop();
    harness.loop.start();
    gate.resolve();
    await Promise.all([settled, stopped]);

    expect(harness.appendUserTurn).toHaveBeenCalledTimes(1);
    expect(harness.startReply).not.toHaveBeenCalled();
  });

  it("does not cancel for a non-trigger source", async () => {
    const harness = createHarness();
    await harness.loop.turnSettled("conversation-1", [turn("u1")], "第一句");

    harness.loop.speechStarted("interviewer");

    expect(harness.cancelReply).not.toHaveBeenCalled();
  });

  it("waits for the cancelled run to settle before starting the next reply", async () => {
    const harness = createHarness();
    await harness.loop.turnSettled("conversation-1", [turn("u1")], "第一句");

    harness.loop.speechStarted("candidate");
    const next = harness.loop.turnSettled("conversation-1", [turn("u2")], "第二句");
    await new Promise<void>((resolve) => setImmediate(resolve));

    // 旧 run 未落账前既不追加新用户消息，也不启动新回复。
    expect(harness.appendUserTurn).toHaveBeenCalledTimes(1);
    expect(harness.startReply).toHaveBeenCalledTimes(1);

    harness.finish("run-1");
    await next;

    expect(harness.appendUserTurn).toHaveBeenCalledTimes(2);
    expect(harness.startReply).toHaveBeenCalledTimes(2);
  });

  it("does not start a reply when the append fails", async () => {
    const harness = createHarness();
    harness.appendUserTurn.mockRejectedValueOnce(new Error("当前回复尚未完成"));

    await harness.loop.turnSettled("conversation-1", [turn()], "第一句");

    expect(harness.startReply).not.toHaveBeenCalled();
    expect(harness.onError).toHaveBeenCalledWith("append", expect.any(Error));
  });

  it("reports a reply start failure without breaking the next turn", async () => {
    const harness = createHarness();
    harness.startReply.mockRejectedValueOnce(new Error("云端模型服务尚未就绪"));

    await harness.loop.turnSettled("conversation-1", [turn("u1")], "第一句");
    await harness.loop.turnSettled("conversation-1", [turn("u2")], "第二句");

    expect(harness.onError).toHaveBeenCalledWith("reply", expect.any(Error));
    expect(harness.startReply).toHaveBeenCalledTimes(2);
    expect(harness.appendUserTurn).toHaveBeenCalledTimes(2);
  });

  it("stops the active reply and still appends turns queued before stop", async () => {
    const harness = createHarness();
    await harness.loop.turnSettled("conversation-1", [turn("u1")], "第一句");

    const queued = harness.loop.turnSettled("conversation-1", [turn("u2")], "第二句");
    const stopped = harness.loop.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.cancelReply).toHaveBeenCalledWith("run-1");

    harness.finish("run-1");
    await Promise.all([queued, stopped]);

    // 停止后不再启动第二回复，但排队中的用户消息仍然落账。
    expect(harness.appendUserTurn).toHaveBeenCalledTimes(2);
    expect(harness.startReply).toHaveBeenCalledTimes(1);
  });
});
