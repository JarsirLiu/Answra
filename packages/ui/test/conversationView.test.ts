import type { AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import {
  applyAgentEvent,
  applyConversationSnapshot,
  type ConversationView,
  EMPTY_CONVERSATION_VIEW,
} from "../src/app/conversationView";

const CONVERSATION = "active-interview-conversation";

function envelope(
  aggregateRevision: number,
  event: AgentEventEnvelope["event"],
  runId = "run-1",
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${aggregateRevision}`,
    conversationId: CONVERSATION,
    runId,
    attemptId: `${runId}:attempt:1`,
    sequence: aggregateRevision,
    aggregateRevision,
    producerId: "test",
    occurredAt: "2026-11-07T00:00:00.000Z",
    event,
  };
}

describe("conversation projection", () => {
  it("keeps snapshot messages and appends streamed text to the active assistant", () => {
    const view = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      eventRevision: 1,
      activeRunId: "run-1",
      messages: [
        { id: "user-1", role: "user", text: "请自我介绍", images: [], status: "complete" },
        { id: "run-1", role: "assistant", text: "", images: [], status: "streaming" },
      ],
    });
    const next = applyAgentEvent(
      view,
      envelope(2, { type: "text-delta", partId: "text-1", delta: "先说经历" }),
    );
    expect(next.messages[1]).toMatchObject({ text: "先说经历", status: "streaming" });
  });

  it("keeps reasoning and rate-limit retry as separate explicit states", () => {
    const base: ConversationView = {
      eventRevision: 1,
      activeRunId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "", status: "streaming" }],
    };
    const thinking = applyAgentEvent(
      base,
      envelope(2, { type: "reasoning-start", partId: "reasoning-1" }),
    );
    expect(thinking.messages[0]?.thinking).toBe(true);
    const retrying = applyAgentEvent(
      thinking,
      envelope(3, {
        type: "run-state-changed",
        state: "retry-wait",
        attempt: 1,
        retry: {
          kind: "rate-limit",
          attempt: 1,
          maxRetries: 5,
          delayMs: 5_000,
          scheduledAt: "2026-11-07T00:00:00.000Z",
        },
      }),
    );
    expect(retrying.messages[0]?.thinking).toBe(true);
    expect(retrying.retry).toMatchObject({ kind: "rate-limit", attempt: 1, maxRetries: 5 });
    expect(retrying.retryRunId).toBe("run-1");
  });

  it("shows the accepted run indicator until an explicit stream event arrives", () => {
    const accepted = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      eventRevision: 0,
      activeRunId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "", images: [], status: "streaming" }],
    });
    expect(accepted.messages[0]?.waitingForStream).toBe(true);
    const thinking = applyAgentEvent(
      accepted,
      envelope(1, { type: "reasoning-start", partId: "reasoning-1" }),
    );
    expect(thinking.messages[0]).toMatchObject({ waitingForStream: false, thinking: true });
  });

  it("restores assistant text, reasoning, and tool activity from transcript parts", () => {
    const restored = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      eventRevision: 8,
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
      eventRevision: 1,
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

  it("keeps text and tool parts in event order while streaming", () => {
    let view: ConversationView = {
      eventRevision: 1,
      activeRunId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "", status: "streaming", parts: [] }],
    };
    view = applyAgentEvent(
      view,
      envelope(2, { type: "text-delta", partId: "text-1", delta: "先" }),
    );
    view = applyAgentEvent(
      view,
      envelope(3, {
        type: "tool-input-start",
        toolCallId: "tool-1",
        toolName: "Read",
      }),
    );
    view = applyAgentEvent(
      view,
      envelope(4, {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "Read",
        input: { file_path: "a.ts" },
      }),
    );
    view = applyAgentEvent(
      view,
      envelope(5, {
        type: "tool-execution-finished",
        toolCallId: "tool-1",
        toolName: "Read",
        input: { file_path: "a.ts" },
        result: { success: true, output: "content" },
        durationMs: 1,
      }),
    );
    view = applyAgentEvent(
      view,
      envelope(6, { type: "text-delta", partId: "text-2", delta: "后" }),
    );

    expect(view.messages[0]?.parts?.map((part) => part.kind)).toEqual(["text", "tool", "text"]);
    expect(view.messages[0]?.text).toBe("先后");
  });

  it("settles a running tool part when the run fails", () => {
    const view: ConversationView = {
      eventRevision: 1,
      activeRunId: "run-1",
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
    const finished = applyAgentEvent(
      view,
      envelope(2, { type: "run-state-changed", state: "failed", attempt: 2 }),
    );

    expect(finished.messages[0]?.parts?.[0]).toMatchObject({ state: "failed" });
  });

  it.each([
    ["completed", "complete"],
    ["failed", "failed"],
    ["aborted", "interrupted"],
    ["superseded", "interrupted"],
    ["orphaned", "failed"],
  ] as const)("maps the %s run terminal state to %s", (runState, messageStatus) => {
    const view: ConversationView = {
      eventRevision: 1,
      activeRunId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "说到一半", status: "streaming" }],
    };
    const finished = applyAgentEvent(
      view,
      envelope(2, { type: "run-state-changed", state: runState, attempt: 1 }),
    );
    expect(finished.activeRunId).toBeUndefined();
    expect(finished.messages[0]).toMatchObject({ status: messageStatus, thinking: false });
  });

  it("keeps a failed retry as a static Wi-Fi record", () => {
    const view: ConversationView = {
      eventRevision: 1,
      activeRunId: "run-1",
      retryRunId: "run-1",
      retry: { kind: "rate-limit", attempt: 5, maxRetries: 5 },
      messages: [{ id: "run-1", role: "assistant", text: "", status: "streaming" }],
    };
    const finished = applyAgentEvent(
      view,
      envelope(2, { type: "run-state-changed", state: "failed", attempt: 6 }),
    );
    expect(finished.retry).toMatchObject({ attempt: 5, maxRetries: 5, finished: true });
    expect(finished.retryRunId).toBe("run-1");
  });

  it("clears a retry record when the run completes successfully", () => {
    const view: ConversationView = {
      eventRevision: 1,
      activeRunId: "run-1",
      retryRunId: "run-1",
      retry: { kind: "rate-limit", attempt: 1, maxRetries: 5 },
      messages: [{ id: "run-1", role: "assistant", text: "答案", status: "streaming" }],
    };
    const finished = applyAgentEvent(
      view,
      envelope(2, { type: "run-state-changed", state: "completed", attempt: 2 }),
    );
    expect(finished.retry).toBeUndefined();
    expect(finished.retryRunId).toBeUndefined();
    expect(finished.messages[0]?.status).toBe("complete");
  });

  it("clears a previous model error when the next run starts", () => {
    const view: ConversationView = {
      eventRevision: 1,
      activeRunId: "run-1",
      error: "Cannot connect to API",
      messages: [{ id: "run-2", role: "assistant", text: "", status: "streaming" }],
    };
    const next = applyAgentEvent(view, envelope(2, { type: "start" }, "run-2"));
    expect(next.error).toBeUndefined();
  });

  it("does not carry a previous model error into a fresh snapshot", () => {
    const view: ConversationView = {
      eventRevision: 2,
      error: "模型流未提供终态",
      messages: [{ id: "run-1", role: "assistant", text: "", status: "failed" }],
    };
    const next = applyConversationSnapshot(view, {
      conversationId: CONVERSATION,
      eventRevision: 3,
      messages: [],
    });
    expect(next.error).toBeUndefined();
  });

  it("ignores old revisions and other conversations", () => {
    const view: ConversationView = { eventRevision: 5, messages: [] };
    expect(applyAgentEvent(view, envelope(5, { type: "start" }))).toBe(view);
  });
});
