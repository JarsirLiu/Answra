import type { ConversationSnapshot } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentModelRequest } from "../../src/core/agent/definition";
import type {
  StepRunContext,
  StepRunner,
  StepRunnerResult,
  StepStart,
} from "../../src/core/session/contracts";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import type { InterviewRehearsalInput } from "../../src/interview/agent";
import { INTERVIEW_REHEARSAL_AGENT_ID } from "../../src/interview/agent";
import { InterviewApplication } from "../../src/interview/application";
import {
  type CommittedInterviewTurn,
  conversationId,
  sessionId,
  turnId,
} from "../../src/interview/contracts";

const MODEL_REQUEST: AgentModelRequest = { system: "interview", messages: [] };

function turn(): CommittedInterviewTurn {
  return {
    sessionId: sessionId("session-1"),
    conversationId: conversationId("conversation-1"),
    turnId: turnId("session-1:u1"),
    version: 0,
    status: "committed",
    chunks: [],
    missingChunkIndexes: [],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createHarness({
  hold,
  withoutEndpoint,
}: {
  hold?: boolean;
  withoutEndpoint?: boolean;
} = {}) {
  const store = new MemoryConversationStore();
  const snapshots: ConversationSnapshot[] = [];
  const prepared: InterviewRehearsalInput[] = [];
  const steps: StepStart[] = [];
  const gate = hold ? deferred() : undefined;
  const executor: AgentExecutor<InterviewRehearsalInput> = {
    prepare: vi.fn(async (input) => {
      prepared.push(input);
      return MODEL_REQUEST;
    }),
  };
  const stepRunner: StepRunner = {
    async run(step: StepStart, _context: StepRunContext): Promise<StepRunnerResult> {
      steps.push(step);
      if (gate) await gate.promise;
      return { outcome: "completed", finishReason: "stop" };
    },
  };
  const agentRuntime = {
    chatContextWindow: () => undefined,
    hasChatEndpoint: () => !withoutEndpoint,
    chatEndpoint: () => ({ baseUrl: "http://localhost", model: "text.chat" }),
    generateText: vi.fn(async () => "summary"),
    modelTokenProvider: () => async () => "token",
  } as unknown as ConstructorParameters<typeof InterviewApplication>[0]["agentRuntime"];
  const app = new InterviewApplication({
    agentRuntime,
    store,
    executor,
    authorAgentId: INTERVIEW_REHEARSAL_AGENT_ID,
    requestAccessToken: vi.fn(async () => "token"),
    stepRunner,
    onSnapshot: async (snapshot) => {
      snapshots.push(snapshot);
    },
    onTurnCommitted: vi.fn(),
    onError: vi.fn(),
  });
  app.setWorkspaceRoot("C:/workspace");
  app.setInterviewDataRoot("C:/data/interview");
  return {
    app,
    snapshots,
    prepared,
    steps,
    release: () => gate?.resolve(),
  };
}

describe("InterviewApplication", () => {
  it("writes the user turn, publishes its snapshot, and replies through one Session Turn", async () => {
    const { app, snapshots, steps, release } = createHarness({ hold: true });

    await app.createConversation("conversation-1");
    app.start();
    await app.turnSettled("conversation-1", [turn()], "请自我介绍");

    expect(snapshots[0]?.messages).toEqual([
      expect.objectContaining({ role: "user", text: "请自我介绍" }),
    ]);
    const active = await app.getSnapshot("conversation-1");
    if (active.activeTurnId === undefined || active.activeMessageId === undefined)
      throw new Error("reply should own an assistant placeholder");
    release?.();
    await app.waitForTurn("conversation-1", active.activeTurnId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual(
      expect.objectContaining({ sessionId: "conversation-1", source: "reply", index: 0 }),
    );
    const snapshot = await app.getSnapshot("conversation-1");
    expect(snapshot.messages.map((message) => [message.role, message.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
  });

  it("sends rehearsal text through the same reply path and resolves by turn id", async () => {
    const { app, snapshots, steps } = createHarness();

    await app.createConversation("conversation-1");
    const result = await app.sendText("conversation-1", "帮我看一下简历");
    await app.waitForTurn("conversation-1", result.turnId);

    expect(result.snapshot.messages[0]).toEqual(
      expect.objectContaining({ role: "user", text: "帮我看一下简历" }),
    );
    const messageId = result.snapshot.activeMessageId;
    expect(messageId).toBeDefined();
    expect(snapshots.some((snapshot) => snapshot.activeMessageId === messageId)).toBe(true);
    expect(steps[0]).toEqual(expect.objectContaining({ source: "reply" }));
  });

  it("records pasted images on the intake user message", async () => {
    const { app, snapshots, steps } = createHarness();
    const image = { name: "简历.png", dataUrl: "data:image/png;base64,QUJD" };

    await app.createConversation("conversation-1");
    const result = await app.sendMessage("conversation-1", { text: "", images: [image] });
    await app.waitForTurn("conversation-1", result.turnId);

    expect(result.snapshot.messages[0]).toEqual(
      expect.objectContaining({ role: "user", text: "", images: [image] }),
    );
    expect(snapshots.at(-1)?.messages[0]?.images).toEqual([image]);
    expect(steps[0]).toEqual(expect.objectContaining({ source: "reply" }));
  });

  it("rejects intake images that are not supported media types", async () => {
    const { app } = createHarness();

    await app.createConversation("conversation-1");
    await expect(
      app.sendMessage("conversation-1", {
        text: "",
        images: [{ name: "note.txt", dataUrl: "data:text/plain;base64,QUJD" }],
      }),
    ).rejects.toThrow("图片格式仅支持 PNG、JPEG、WebP 或 GIF");
  });

  it("opens with an assistant placeholder and no user message", async () => {
    const { app, steps, release } = createHarness({ hold: true });

    const result = await app.open("conversation-1");

    expect(result.turnId).toBeDefined();
    expect(result.snapshot.messages).toEqual([
      expect.objectContaining({ role: "assistant", status: "streaming" }),
    ]);
    release();
    await app.waitForTurn("conversation-1", result.turnId as string);
    expect(steps[0]).toEqual(expect.objectContaining({ source: "opening", index: 0 }));
    expect((await app.getSnapshot("conversation-1")).messages).toEqual([
      expect.objectContaining({ role: "assistant", status: "complete" }),
    ]);
  });

  it("does not start a second opening when the session already has messages", async () => {
    const { app, steps } = createHarness();

    await app.open("conversation-1");
    const result = await app.open("conversation-1");

    expect(result.turnId).toBeUndefined();
    expect(steps).toHaveLength(1);
  });

  it("opens an empty session without an opening turn when no model endpoint is configured", async () => {
    const { app, steps } = createHarness({ withoutEndpoint: true });

    const result = await app.open("conversation-1");

    expect(result.turnId).toBeUndefined();
    expect(result.snapshot.messages).toEqual([]);
    expect(steps).toHaveLength(0);
  });
});
