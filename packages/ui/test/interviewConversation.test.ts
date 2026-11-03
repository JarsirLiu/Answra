import type { ConversationChange } from "@answra/shared";
import { describe, expect, it } from "vitest";
import {
  applyInterviewChange,
  EMPTY_INTERVIEW_CONVERSATION,
} from "../src/app/interviewConversation";

const CONVERSATION = "active-interview-conversation";

describe("interview conversation projection", () => {
  it("keeps user and assistant messages in one revision-ordered timeline", () => {
    const withSnapshot = applyInterviewChange(
      EMPTY_INTERVIEW_CONVERSATION,
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
    const withUser = applyInterviewChange(
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
    const withReply = applyInterviewChange(
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
    const streamed = applyInterviewChange(
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
      { id: "user-1", role: "user", text: "请自我介绍", status: "complete" },
      { id: "run-1", role: "assistant", text: "先说经历", status: "streaming" },
    ]);
  });

  it("applies the interrupted status when a newer speech cancels the reply", () => {
    const streaming = applyInterviewChange(
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
    const next = applyInterviewChange(
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
      { id: "run-2", role: "assistant", text: "", status: "streaming" },
    ]);
  });

  it("keeps the previous error when only a user message is appended", () => {
    const errored = { revision: 3, messages: [], error: "模型请求失败" };
    const next = applyInterviewChange(
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
      applyInterviewChange(
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
      applyInterviewChange(
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

    expect(applyInterviewChange({ revision: 3, messages: [] }, change, CONVERSATION).error).toBe(
      "模型请求失败",
    );
  });
});
