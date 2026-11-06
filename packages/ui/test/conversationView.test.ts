import type { ConversationChange } from "@answra/shared";
import { describe, expect, it } from "vitest";
import {
  applyConversationChange,
  applyHistoricalConversationEvent,
  type ConversationView,
  EMPTY_CONVERSATION_VIEW,
} from "../src/app/conversationView";

const CONVERSATION = "active-interview-conversation";

describe("conversation projection", () => {
  it("keeps user and assistant messages in one revision-ordered timeline", () => {
    const withSnapshot = applyConversationChange(
      EMPTY_CONVERSATION_VIEW,
      {
        type: "snapshot",
        snapshot: {
          conversationId: CONVERSATION,
          revision: 0,
          messages: [],
        },
      },
      CONVERSATION,
    );
    const withUser = applyConversationChange(
      withSnapshot,
      {
        type: "messages-appended",
        conversationId: CONVERSATION,
        revision: 1,
        messages: [
          { id: "user-1", role: "user", text: "请自我介绍", images: [], status: "complete" },
        ],
      },
      CONVERSATION,
    );
    const withReply = applyConversationChange(
      withUser,
      {
        type: "messages-appended",
        conversationId: CONVERSATION,
        revision: 2,
        messages: [{ id: "run-1", role: "assistant", text: "", images: [], status: "streaming" }],
        activeRunId: "run-1",
      },
      CONVERSATION,
    );
    const streamed = applyConversationChange(
      withReply,
      {
        type: "event",
        event: {
          conversationId: CONVERSATION,
          runId: "run-1",
          revision: 3,
          seq: 1,
          stream: { type: "text-delta", partId: "text-1", delta: "先说经历" },
        },
      },
      CONVERSATION,
    );

    expect(streamed.messages).toEqual([
      {
        id: "user-1",
        role: "user",
        text: "请自我介绍",
        status: "complete",
        images: [],
      },
      {
        id: "run-1",
        role: "assistant",
        text: "先说经历",
        status: "streaming",
        images: [],
      },
    ]);
  });

  it("accumulates reasoning deltas for the thinking chain", () => {
    const view = applyConversationChange(
      {
        revision: 2,
        messages: [{ id: "run-1", role: "assistant", text: "", status: "streaming" }],
      },
      {
        type: "event",
        event: {
          conversationId: CONVERSATION,
          runId: "run-1",
          revision: 3,
          seq: 1,
          stream: { type: "reasoning-delta", partId: "reasoning-1", delta: "先分析" },
        },
      },
      CONVERSATION,
    );

    expect(view.messages[0]?.reasoning).toBe("先分析");
  });

  it("tracks reply activities only when the surface asks for them", () => {
    const event: ConversationChange = {
      type: "event",
      event: {
        conversationId: CONVERSATION,
        runId: "run-1",
        revision: 3,
        seq: 1,
        stream: { type: "tool-result", toolCallId: "tool-1", output: "检索完成" },
      },
    };
    const base = {
      revision: 2,
      messages: [
        { id: "run-1", role: "assistant" as const, text: "", status: "streaming" as const },
      ],
    };

    expect(
      applyConversationChange(base, event, CONVERSATION).messages[0]?.activities,
    ).toBeUndefined();
    expect(
      applyConversationChange(base, event, CONVERSATION, { trackActivities: true }).messages[0]
        ?.activities?.[0]?.text,
    ).toBe("检索完成");
  });

  it("applies the interrupted status when a newer speech cancels the reply", () => {
    const streaming = applyConversationChange(
      {
        revision: 2,
        messages: [
          {
            id: "run-1",
            role: "assistant" as const,
            text: "说到一半",
            status: "streaming" as const,
          },
        ],
      },
      {
        type: "run-finished",
        conversationId: CONVERSATION,
        revision: 3,
        runId: "run-1",
        outcome: "aborted",
        message: {
          id: "run-1",
          role: "assistant",
          text: "说到一半",
          images: [],
          status: "interrupted",
        },
      },
      CONVERSATION,
    );

    expect(streaming.messages[0]).toMatchObject({ status: "interrupted", text: "说到一半" });
  });

  it("clears the previous error when a new assistant run starts", () => {
    const errored = { revision: 3, messages: [], error: "模型请求失败" };
    const next = applyConversationChange(
      errored,
      {
        type: "messages-appended",
        conversationId: CONVERSATION,
        revision: 4,
        messages: [{ id: "run-2", role: "assistant", text: "", images: [], status: "streaming" }],
        activeRunId: "run-2",
      },
      CONVERSATION,
    );

    expect(next.error).toBeUndefined();
    expect(next.messages).toEqual([
      {
        id: "run-2",
        role: "assistant",
        text: "",
        status: "streaming",
        images: [],
      },
    ]);
  });

  it("keeps the previous error when only a user message is appended", () => {
    const errored = { revision: 3, messages: [], error: "模型请求失败" };
    const next = applyConversationChange(
      errored,
      {
        type: "messages-appended",
        conversationId: CONVERSATION,
        revision: 4,
        messages: [
          { id: "user-2", role: "user", text: "补充一句", images: [], status: "complete" },
        ],
      },
      CONVERSATION,
    );

    expect(next.error).toBe("模型请求失败");
  });

  it("ignores older revisions and other conversations", () => {
    const view = { revision: 5, messages: [] };
    expect(
      applyConversationChange(
        view,
        {
          type: "messages-appended",
          conversationId: CONVERSATION,
          revision: 5,
          messages: [
            { id: "user-1", role: "user", text: "旧消息", images: [], status: "complete" },
          ],
        },
        CONVERSATION,
      ),
    ).toBe(view);
    expect(
      applyConversationChange(
        view,
        {
          type: "messages-appended",
          conversationId: "other",
          revision: 6,
          messages: [
            { id: "user-1", role: "user", text: "别的会话", images: [], status: "complete" },
          ],
        },
        CONVERSATION,
      ),
    ).toBe(view);
  });

  it("surfaces provider errors from the stream", () => {
    const change: ConversationChange = {
      type: "event",
      event: {
        conversationId: CONVERSATION,
        runId: "run-1",
        revision: 4,
        seq: 1,
        stream: { type: "error", errorText: "模型请求失败" },
      },
    };

    expect(
      applyConversationChange(
        {
          revision: 3,
          activeRunId: "run-1",
          messages: [{ id: "run-1", role: "assistant", text: "", status: "streaming" }],
        },
        change,
        CONVERSATION,
      ).error,
    ).toBe("模型请求失败");
  });

  it("keeps retry state in place and clears it when the run starts streaming", () => {
    const base = {
      revision: 2,
      activeRunId: "run-1",
      messages: [
        { id: "run-1", role: "assistant" as const, text: "", status: "streaming" as const },
      ],
    };
    const retrying = applyConversationChange(
      base,
      {
        type: "event",
        event: {
          conversationId: CONVERSATION,
          runId: "run-1",
          revision: 3,
          seq: 1,
          stream: {
            type: "retry",
            kind: "rate-limit",
            attempt: 1,
            maxRetries: 5,
            delayMs: 5_000,
          },
        },
      },
      CONVERSATION,
    );
    expect(retrying.retry).toEqual({ kind: "rate-limit", attempt: 1, maxRetries: 5 });
    expect(retrying.retryRunId).toBe("run-1");

    const second = applyConversationChange(
      retrying,
      {
        type: "event",
        event: {
          conversationId: CONVERSATION,
          runId: "run-1",
          revision: 4,
          seq: 2,
          stream: {
            type: "retry",
            kind: "rate-limit",
            attempt: 2,
            maxRetries: 5,
            delayMs: 10_000,
          },
        },
      },
      CONVERSATION,
    );
    expect(second.retry).toEqual({ kind: "rate-limit", attempt: 2, maxRetries: 5 });

    const started = applyConversationChange(
      second,
      {
        type: "event",
        event: {
          conversationId: CONVERSATION,
          runId: "run-1",
          revision: 5,
          seq: 3,
          stream: { type: "start" },
        },
      },
      CONVERSATION,
    );
    expect(started.retry).toBeUndefined();
  });

  it("clears retry state when the run finishes", () => {
    const retrying: ConversationView = {
      revision: 3,
      activeRunId: "run-1",
      retry: { kind: "rate-limit", attempt: 1, maxRetries: 5 },
      retryRunId: "run-1",
      messages: [
        { id: "run-1", role: "assistant" as const, text: "", status: "streaming" as const },
      ],
    };
    const finished = applyConversationChange(
      retrying,
      {
        type: "run-finished",
        conversationId: CONVERSATION,
        revision: 4,
        runId: "run-1",
        outcome: "failed",
        message: { id: "run-1", role: "assistant", text: "", images: [], status: "failed" },
      },
      CONVERSATION,
    );

    expect(finished.retry).toEqual({
      kind: "rate-limit",
      attempt: 1,
      maxRetries: 5,
      finished: true,
    });
    expect(finished.messages[0]).toMatchObject({ status: "failed", thinking: false });
  });

  it("uses explicit stream events for thinking instead of inferring it from empty text", () => {
    const base: ConversationView = {
      revision: 2,
      activeRunId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "", status: "streaming" }],
    };
    const started = applyConversationChange(
      base,
      {
        type: "event",
        event: {
          conversationId: CONVERSATION,
          runId: "run-1",
          revision: 3,
          seq: 1,
          stream: { type: "reasoning-start", partId: "reasoning-1" },
        },
      },
      CONVERSATION,
    );
    expect(started.messages[0]?.thinking).toBe(true);

    const retrying = applyConversationChange(
      started,
      {
        type: "event",
        event: {
          conversationId: CONVERSATION,
          runId: "run-1",
          revision: 4,
          seq: 2,
          stream: {
            type: "retry",
            kind: "rate-limit",
            attempt: 1,
            maxRetries: 5,
            delayMs: 5_000,
          },
        },
      },
      CONVERSATION,
    );
    expect(retrying.messages[0]?.thinking).toBe(false);
    expect(retrying.retry).toEqual({ kind: "rate-limit", attempt: 1, maxRetries: 5 });
  });

  it("replays the persisted retry event after a failed run", () => {
    const snapshot: ConversationView = {
      revision: 5,
      messages: [{ id: "run-1", role: "assistant", text: "", status: "failed" }],
    };
    const replayed = applyHistoricalConversationEvent(
      snapshot,
      {
        type: "event",
        event: {
          conversationId: CONVERSATION,
          runId: "run-1",
          revision: 3,
          seq: 1,
          stream: {
            type: "retry",
            kind: "rate-limit",
            attempt: 5,
            maxRetries: 5,
            delayMs: 80_000,
          },
        },
      },
      CONVERSATION,
    );
    expect(replayed.retry).toEqual({ kind: "rate-limit", attempt: 5, maxRetries: 5 });
    expect(replayed.retryRunId).toBe("run-1");
  });
});
