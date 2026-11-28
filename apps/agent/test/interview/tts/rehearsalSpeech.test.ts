import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentModelRequest } from "../../../src/core/agent/definition";
import type { StepRunner } from "../../../src/core/session/contracts";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";
import type { InterviewRehearsalInput } from "../../../src/interview/agent";
import { INTERVIEW_REHEARSAL_AGENT_ID } from "../../../src/interview/agent";
import { InterviewApplication } from "../../../src/interview/application";
import { rehearsalSpeechIntent, speakableText } from "../../../src/interview/tts/rehearsalSpeech";

const MODEL_REQUEST: AgentModelRequest = { system: "interview", messages: [] };

function assistant(parts: ConversationMessage["parts"], text = ""): ConversationMessage {
  return {
    id: "message-1",
    role: "assistant",
    text,
    images: [],
    status: "complete",
    ...(parts === undefined ? {} : { parts }),
  };
}

describe("rehearsalSpeechIntent", () => {
  it("turns a completed assistant text into a single final delta", () => {
    const intent = rehearsalSpeechIntent(
      "conversation-1",
      assistant([
        { id: "p1", kind: "text", state: "completed", text: "第一段。" },
        { id: "p2", kind: "text", state: "completed", text: "第二段。" },
      ]),
    );

    expect(intent).toEqual({
      conversationId: "conversation-1",
      messageId: "message-1",
      sequence: 0,
      delta: "第一段。\n第二段。",
      final: true,
    });
  });

  it("never reads reasoning, tools, or user messages", () => {
    expect(
      rehearsalSpeechIntent(
        "conversation-1",
        assistant([
          { id: "p1", kind: "reasoning", state: "completed", text: "先想一想。" },
          { id: "p2", kind: "text", state: "completed", text: "正式回答。" },
        ]),
      )?.delta,
    ).toBe("正式回答。");

    expect(rehearsalSpeechIntent("conversation-1", { ...assistant([]), role: "user" })).toBe(
      undefined,
    );
    expect(rehearsalSpeechIntent("conversation-1", assistant([]))).toBe(undefined);
  });

  it("falls back to the message text when parts are absent", () => {
    expect(speakableText(assistant(undefined, " 历史正文 "))).toBe("历史正文");
  });
});

describe("InterviewApplication rehearsal speech", () => {
  it("reports the settled assistant message exactly once", async () => {
    const store = new MemoryConversationStore();
    const replies: Array<{ conversationId: string; message: ConversationMessage }> = [];
    const stepRunner: StepRunner = {
      async run(_step, context) {
        const partId = "part-1";
        await context.events.append({ type: "text-start", partId });
        await context.events.append({ type: "text-delta", partId, delta: "你好，我们先从" });
        await context.events.append({ type: "text-delta", partId, delta: "自我介绍开始。" });
        await context.events.append({ type: "text-end", partId });
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const agentRuntime = {
      chatContextWindow: () => undefined,
      hasChatEndpoint: () => true,
      chatEndpoint: () => ({ baseUrl: "http://localhost", model: "text.chat" }),
      generateText: vi.fn(async () => "summary"),
      modelTokenProvider: () => async () => "token",
    } as unknown as ConstructorParameters<typeof InterviewApplication>[0]["agentRuntime"];
    const executor: AgentExecutor<InterviewRehearsalInput> = {
      prepare: vi.fn(async () => MODEL_REQUEST),
    };
    const app = new InterviewApplication({
      agentRuntime,
      store,
      executor,
      authorAgentId: INTERVIEW_REHEARSAL_AGENT_ID,
      requestAccessToken: vi.fn(async () => "token"),
      stepRunner,
      onSnapshot: async () => undefined,
      onTurnCommitted: vi.fn(),
      onAssistantReply: (conversationId, message) => replies.push({ conversationId, message }),
      onError: vi.fn(),
    });

    await app.createConversation("conversation-1");
    const result = await app.sendText("conversation-1", "开始演练");
    await app.waitForTurn("conversation-1", result.turnId);

    expect(replies).toHaveLength(1);
    const reply = replies[0];
    if (reply === undefined) throw new Error("assistant reply was not reported");
    expect(rehearsalSpeechIntent(reply.conversationId, reply.message)).toEqual({
      conversationId: "conversation-1",
      messageId: result.snapshot.activeMessageId,
      sequence: 0,
      delta: "你好，我们先从自我介绍开始。",
      final: true,
    });
  });
});
