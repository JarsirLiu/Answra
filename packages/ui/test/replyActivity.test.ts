import type { ConversationEvent } from "@answra/shared";
import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { projectReplyActivity } from "../src/app/replyActivity";

const conversationId = "active-exam-conversation";
const runId = "run-1";

function event(revision: number, chunk: object): ConversationEvent {
  return {
    conversationId,
    runId,
    revision,
    chunk: chunk as UIMessageChunk,
  };
}

describe("projectReplyActivity chunk identity", () => {
  it("keeps interleaved reasoning blocks independent and appends deltas by chunk id", () => {
    let activities = projectReplyActivity(
      [],
      event(1, { type: "reasoning-delta", id: "reason-1", delta: "思考一" }),
    );
    activities = projectReplyActivity(
      activities,
      event(2, { type: "reasoning-delta", id: "reason-2", delta: "思考二" }),
    );
    activities = projectReplyActivity(
      activities,
      event(3, { type: "reasoning-delta", id: "reason-1", delta: "继续" }),
    );

    expect(activities).toEqual([
      { id: "reason-1", kind: "thinking", label: "思考", text: "思考一继续" },
      { id: "reason-2", kind: "thinking", label: "思考", text: "思考二" },
    ]);
  });

  it("keeps tool input and output events scoped to their toolCallId", () => {
    let activities = projectReplyActivity(
      [],
      event(1, {
        type: "tool-input-start",
        toolCallId: "call-1",
        toolName: "lookup",
      }),
    );
    activities = projectReplyActivity(
      activities,
      event(2, {
        type: "tool-input-start",
        toolCallId: "call-2",
        toolName: "lookup",
      }),
    );
    activities = projectReplyActivity(
      activities,
      event(3, { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: '{"q":' }),
    );
    activities = projectReplyActivity(
      activities,
      event(4, { type: "tool-input-delta", toolCallId: "call-2", inputTextDelta: '{"q":' }),
    );
    activities = projectReplyActivity(
      activities,
      event(5, { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: '"a"}' }),
    );

    expect(activities).toMatchObject([
      { id: "call-1:start", text: "准备调用" },
      { id: "call-2:start", text: "准备调用" },
      { id: "call-1:input", text: '{"q":"a"}' },
      { id: "call-2:input", text: '{"q":' },
    ]);
  });
});
