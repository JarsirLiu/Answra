import type {
  AgentLiveOnlyEvent,
  LiveFrame,
  SessionFrame,
  SessionItem,
} from "@answra/shared/schema";
import { SESSION_FRAME_SCHEMA_VERSION } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import {
  applyConversationSnapshot,
  type ConversationView,
  EMPTY_CONVERSATION_VIEW,
  foldConversationFrame,
  overlayLiveFrame,
} from "../src/app/conversationView";

const CONVERSATION = "active-interview-conversation";
const AT = "2026-11-07T00:00:00.000Z";

type ItemDraft = Omit<SessionItem, "seq">;

function frame(
  seq: number,
  item: ItemDraft,
  ids: { turnId?: string; messageId?: string } = {},
): SessionFrame {
  return {
    schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
    sessionId: CONVERSATION,
    seq,
    eventId: `${CONVERSATION}:${seq}`,
    occurredAt: AT,
    producerId: "test",
    ...(ids.turnId === undefined ? {} : { turnId: ids.turnId }),
    ...(ids.messageId === undefined ? {} : { messageId: ids.messageId }),
    event: { type: "session-item", item: { ...item, seq } },
  };
}

/** live 增量没有序号，只影响瞬时观感；条目到达后覆盖。 */
function live(event: AgentLiveOnlyEvent, messageId = "run-1"): LiveFrame {
  return { sessionId: CONVERSATION, messageId, event };
}

function textItem(text: string, partId = "text-1"): ItemDraft {
  return {
    itemId: partId,
    status: "complete",
    createdAt: AT,
    turnId: "turn-1",
    messageId: "run-1",
    payload: { kind: "text", text },
  };
}

function toolCallItem(toolCallId = "tool-1"): ItemDraft {
  return {
    itemId: toolCallId,
    status: "complete",
    createdAt: AT,
    turnId: "turn-1",
    messageId: "run-1",
    payload: { kind: "tool-call", toolCallId, toolName: "Read", input: { path: "a.ts" } },
  };
}

function toolResultItem(
  toolCallId = "tool-1",
  outcome: "output" | "error" | "denied" = "output",
): ItemDraft {
  return {
    itemId: `${toolCallId}:result`,
    status: "complete",
    createdAt: AT,
    turnId: "turn-1",
    messageId: "run-1",
    payload: {
      kind: "tool-result",
      toolCallId,
      outcome,
      ...(outcome === "output" ? { output: "content" } : { errorText: "tool failed" }),
    },
  };
}

function turnEndItem(
  status: "complete" | "interrupted" | "failed",
  extra: { errorText?: string } = {},
): ItemDraft {
  return {
    itemId: "turn-1:end",
    status,
    createdAt: AT,
    turnId: "turn-1",
    payload: {
      kind: "turn-end",
      stepCount: 1,
      toolCalls: 0,
      ...(status === "interrupted"
        ? { interruption: { reason: "cancelled" as const, at: AT } }
        : {}),
      ...(extra.errorText === undefined ? {} : { errorText: extra.errorText }),
    },
  };
}

function streamingView(): ConversationView {
  return {
    lastSeq: 1,
    activeTurnId: "turn-1",
    activeMessageId: "run-1",
    messages: [{ id: "run-1", role: "assistant", text: "", images: [], status: "streaming" }],
  };
}

describe("conversation projection", () => {
  it("keeps snapshot messages and appends streamed text to the active assistant", () => {
    const view = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      activeMessageId: "run-1",
      messages: [
        { id: "user-1", role: "user", text: "请自我介绍", images: [], status: "complete" },
        { id: "run-1", role: "assistant", text: "", images: [], status: "streaming" },
      ],
    });
    const next = overlayLiveFrame(
      view,
      live({ type: "text-delta", partId: "text-1", delta: "先说经历" }),
    );
    expect(next.messages[1]).toMatchObject({ text: "先说经历", status: "streaming" });
  });

  it("folds a settled item into its message and advances the durable cursor", () => {
    const base: ConversationView = {
      lastSeq: 0,
      messages: [
        {
          id: "run-1",
          role: "assistant",
          text: "answer",
          images: [],
          status: "streaming",
          parts: [{ id: "text-1", kind: "text", text: "answer", state: "streaming" }],
        },
      ],
    };

    const folded = foldConversationFrame(base, frame(1, textItem("answer+")));

    expect(folded.lastSeq).toBe(1);
    expect(folded.messages[0]).toMatchObject({ text: "answer+", waitingForStream: false });
    expect(folded.messages[0]?.parts).toEqual([
      { id: "text-1", kind: "text", text: "answer+", state: "completed" },
    ]);
  });

  it("keeps reasoning and rate-limit retry as separate live-only states", () => {
    const thinking = overlayLiveFrame(
      streamingView(),
      live({ type: "reasoning-delta", partId: "reasoning-1", delta: "先想" }),
    );
    expect(thinking.messages[0]).toMatchObject({ thinking: true, waitingForStream: false });

    const retrying = overlayLiveFrame(
      thinking,
      live({
        type: "retry",
        kind: "rate-limit",
        attempt: 1,
        maxRetries: 5,
        delayMs: 5_000,
        statusCode: 429,
      }),
    );
    expect(retrying.messages[0]?.thinking).toBe(true);
    expect(retrying.retry).toMatchObject({
      kind: "rate-limit",
      attempt: 1,
      maxRetries: 5,
      statusCode: 429,
    });
    expect(retrying.retryMessageId).toBe("run-1");
  });

  it("shows the accepted turn indicator until live content arrives", () => {
    const accepted = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      activeTurnId: "turn-1",
      activeMessageId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "", images: [], status: "streaming" }],
    });
    expect(accepted.messages[0]?.waitingForStream).toBe(true);
    const thinking = overlayLiveFrame(
      accepted,
      live({ type: "reasoning-delta", partId: "reasoning-1", delta: "先想" }),
    );
    expect(thinking.messages[0]).toMatchObject({ waitingForStream: false, thinking: true });
  });

  it("restores assistant text, reasoning, and tool activity from transcript parts", () => {
    const restored = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [
        {
          id: "run-1",
          role: "assistant",
          text: "legacy text",
          reasoning: "legacy reasoning",
          images: [],
          status: "complete",
          parts: [
            { id: "text-1", kind: "text", text: "part text", state: "completed" },
            { id: "reason-1", kind: "reasoning", text: "part reasoning", state: "completed" },
            {
              id: "tool-1",
              kind: "tool",
              toolCallId: "tool-1",
              toolName: "Search",
              state: "completed",
              input: { query: "topic" },
              output: "result",
            },
          ],
        },
      ],
    });

    expect(restored.messages[0]).toMatchObject({
      text: "part text",
      reasoning: "part reasoning",
      activities: [
        { id: "tool-1:input-ready", kind: "tool", label: "工具：Search" },
        { id: "tool-1:output", kind: "tool", label: "工具结果", text: "result" },
      ],
    });
    expect(restored.messages[0]?.parts?.map((part) => part.kind)).toEqual([
      "text",
      "reasoning",
      "tool",
    ]);
  });

  it("synthesizes ordered parts for legacy messages without persisted parts", () => {
    const restored = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [
        {
          id: "run-1",
          role: "assistant",
          text: "legacy text",
          reasoning: "legacy reasoning",
          images: [],
          status: "complete",
        },
      ],
    });

    expect(restored.messages[0]?.parts?.map((part) => part.kind)).toEqual(["reasoning", "text"]);
  });

  it("keeps text and tool parts in item order while streaming", () => {
    let view: ConversationView = {
      lastSeq: 0,
      activeTurnId: "turn-1",
      activeMessageId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "", status: "streaming", parts: [] }],
    };
    view = overlayLiveFrame(view, live({ type: "text-delta", partId: "text-1", delta: "先" }));
    view = foldConversationFrame(view, frame(1, toolCallItem()));
    view = foldConversationFrame(view, frame(2, toolResultItem()));
    view = overlayLiveFrame(view, live({ type: "text-delta", partId: "text-2", delta: "后" }));

    expect(view.messages[0]?.parts?.map((part) => part.kind)).toEqual(["text", "tool", "text"]);
    expect(view.messages[0]?.text).toBe("先后");
    expect(view.messages[0]?.parts?.[1]).toMatchObject({ state: "completed", output: "content" });
  });

  it("ignores a tool result whose tool call never arrived", () => {
    const folded = foldConversationFrame(streamingView(), frame(2, toolResultItem("tool-9")));

    expect(folded.messages[0]?.parts ?? []).toEqual([]);
  });

  it("settles a running tool part when the turn fails", () => {
    const view: ConversationView = {
      lastSeq: 1,
      activeTurnId: "turn-1",
      activeMessageId: "run-1",
      messages: [
        {
          id: "run-1",
          role: "assistant",
          text: "",
          status: "streaming",
          parts: [
            {
              id: "tool-1",
              kind: "tool",
              toolCallId: "tool-1",
              toolName: "Read",
              state: "running",
            },
          ],
        },
      ],
    };
    const finished = foldConversationFrame(view, frame(2, turnEndItem("failed")));

    expect(finished.messages[0]?.parts?.[0]).toMatchObject({ state: "failed" });
    expect(finished.activeTurnId).toBeUndefined();
  });

  it("preserves event-updated provider usage when snapshot carries estimate", () => {
    const withProvider: ConversationView = {
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 200_000,
        usedTokens: 15_000,
        source: "provider",
        inputLimit: 180_000,
        compactAt: 180_000,
        pruneAt: 160_000,
        pruneTarget: 140_000,
        updatedAt: "2026-11-19T12:00:00.000Z",
      },
    };
    const snapshot = applyConversationSnapshot(withProvider, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 200_000,
        usedTokens: 12_000,
        source: "estimate",
        inputLimit: 180_000,
        compactAt: 180_000,
        pruneAt: 160_000,
        pruneTarget: 140_000,
        updatedAt: "2026-11-19T12:00:00.000Z",
      },
    });

    expect(snapshot.contextUsage).toMatchObject({
      usedTokens: 15_000,
      source: "provider",
    });
  });

  it("accepts snapshot provider usage over view estimate", () => {
    const withEstimate: ConversationView = {
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 200_000,
        usedTokens: 12_000,
        source: "estimate",
        inputLimit: 180_000,
        compactAt: 180_000,
        pruneAt: 160_000,
        pruneTarget: 140_000,
        updatedAt: "2026-11-19T12:00:00.000Z",
      },
    };
    const snapshot = applyConversationSnapshot(withEstimate, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 200_000,
        usedTokens: 15_000,
        source: "provider",
        inputLimit: 180_000,
        compactAt: 180_000,
        pruneAt: 160_000,
        pruneTarget: 140_000,
        updatedAt: "2026-11-19T12:00:00.000Z",
      },
    });

    expect(snapshot.contextUsage).toMatchObject({
      usedTokens: 15_000,
      source: "provider",
    });
  });

  it("accepts a newer post-compaction estimate over the previous provider usage", () => {
    const withProvider: ConversationView = {
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 200_000,
        usedTokens: 212_300,
        source: "provider",
        inputLimit: 180_000,
        compactAt: 180_000,
        pruneAt: 160_000,
        pruneTarget: 140_000,
        updatedAt: "2026-11-20T12:00:00.000Z",
      },
    };
    const snapshot = applyConversationSnapshot(withProvider, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 200_000,
        usedTokens: 50_000,
        source: "compaction",
        inputLimit: 180_000,
        compactAt: 180_000,
        pruneAt: 160_000,
        pruneTarget: 140_000,
        updatedAt: "2026-11-20T12:00:01.000Z",
      },
    });

    expect(snapshot.contextUsage).toMatchObject({
      usedTokens: 50_000,
      source: "compaction",
    });
  });

  it("keeps provider usage when an older compaction snapshot arrives", () => {
    const withProvider: ConversationView = {
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 200_000,
        usedTokens: 45_000,
        source: "provider",
        inputLimit: 180_000,
        compactAt: 180_000,
        pruneAt: 160_000,
        pruneTarget: 140_000,
        updatedAt: "2026-11-20T12:00:01.000Z",
      },
    };
    const snapshot = applyConversationSnapshot(withProvider, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 200_000,
        usedTokens: 50_000,
        source: "compaction",
        inputLimit: 180_000,
        compactAt: 180_000,
        pruneAt: 160_000,
        pruneTarget: 140_000,
        updatedAt: "2026-11-20T12:00:00.000Z",
      },
    });

    expect(snapshot.contextUsage).toMatchObject({
      usedTokens: 45_000,
      source: "provider",
    });
  });

  it("initializes contextUsage from snapshot when view has none", () => {
    const snapshot = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 200_000,
        usedTokens: 5_000,
        source: "estimate",
        inputLimit: 180_000,
        compactAt: 180_000,
        pruneAt: 160_000,
        pruneTarget: 140_000,
        updatedAt: "2026-11-19T12:00:00.000Z",
      },
    });

    expect(snapshot.contextUsage).toMatchObject({
      usedTokens: 5_000,
      source: "estimate",
    });
  });

  it.each([
    ["complete", "complete"],
    ["failed", "failed"],
    ["interrupted", "interrupted"],
  ] as const)("maps the %s turn-end item to %s message status", (itemStatus, messageStatus) => {
    const finished = foldConversationFrame(streamingView(), frame(2, turnEndItem(itemStatus)));

    expect(finished.activeMessageId).toBeUndefined();
    expect(finished.messages[0]).toMatchObject({ status: messageStatus, thinking: false });
  });

  it("takes the turn error text from the turn-end item", () => {
    const failed = foldConversationFrame(
      streamingView(),
      frame(2, turnEndItem("failed", { errorText: "Cannot connect to API" })),
    );
    expect(failed.error).toBe("Cannot connect to API");

    const recovered = foldConversationFrame(failed, frame(3, turnEndItem("complete")));
    expect(recovered.error).toBeUndefined();
  });

  it("keeps a failed retry as a static Wi-Fi record", () => {
    const view: ConversationView = {
      ...streamingView(),
      retryMessageId: "run-1",
      retry: { kind: "rate-limit", attempt: 5, maxRetries: 5 },
    };
    const finished = foldConversationFrame(view, frame(2, turnEndItem("failed")));
    expect(finished.retry).toMatchObject({ attempt: 5, maxRetries: 5, finished: true });
    expect(finished.retryMessageId).toBe("run-1");
  });

  it("clears a retry record when the turn completes successfully", () => {
    const view: ConversationView = {
      ...streamingView(),
      retryMessageId: "run-1",
      retry: { kind: "rate-limit", attempt: 1, maxRetries: 5 },
    };
    const finished = foldConversationFrame(view, frame(2, turnEndItem("complete")));
    expect(finished.retry).toBeUndefined();
    expect(finished.retryMessageId).toBeUndefined();
    expect(finished.messages[0]?.status).toBe("complete");
  });

  it("clears a previous model error when live content resumes", () => {
    const view: ConversationView = {
      lastSeq: 1,
      error: "Cannot connect to API",
      messages: [{ id: "run-2", role: "assistant", text: "", status: "streaming" }],
    };
    const next = overlayLiveFrame(
      view,
      live({ type: "text-delta", partId: "text-1", delta: "重试后" }, "run-2"),
    );
    expect(next.error).toBeUndefined();
  });

  it("does not carry a previous model error into a fresh snapshot", () => {
    const view: ConversationView = {
      lastSeq: 0,
      error: "模型流未提供终态",
      messages: [{ id: "run-1", role: "assistant", text: "", status: "failed" }],
    };
    const next = applyConversationSnapshot(view, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [],
    });
    expect(next.error).toBeUndefined();
  });

  it("carries context compaction state from the snapshot", () => {
    const view = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [],
      contextCompaction: {
        state: "failed",
        trigger: "auto",
        startedAt: "2026-11-13T10:00:00.000Z",
        updatedAt: "2026-11-13T10:00:01.000Z",
        finishedAt: "2026-11-13T10:00:01.000Z",
        errorText: "摘要模型不可用",
      },
    });

    expect(view.contextCompaction).toMatchObject({
      state: "failed",
      errorText: "摘要模型不可用",
    });
  });

  it("carries context usage and pruning state from the snapshot", () => {
    const view = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      lastSeq: 0,
      messages: [],
      contextUsage: {
        contextWindow: 256_000,
        usedTokens: 45_000,
        source: "provider",
        inputLimit: 216_000,
        compactAt: 216_000,
        pruneAt: 172_000,
        pruneTarget: 40_000,
        updatedAt: "2026-11-14T10:00:00.000Z",
      },
      contextPruning: {
        trigger: "auto",
        prunedCount: 2,
        savedTokens: 30_000,
        updatedAt: "2026-11-14T10:00:00.000Z",
      },
    });

    expect(view.contextUsage).toMatchObject({ usedTokens: 45_000, inputLimit: 216_000 });
    expect(view.contextPruning).toMatchObject({ prunedCount: 2, savedTokens: 30_000 });
  });

  it("ignores a replayed frame seq", () => {
    const view: ConversationView = { lastSeq: 5, messages: [] };
    expect(foldConversationFrame(view, frame(5, textItem("重复")))).toBe(view);
  });
});
