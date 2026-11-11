import type { AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../src/core/agent/definition";
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

function createHarness() {
  const store = new MemoryConversationStore();
  const snapshots: unknown[] = [];
  let preparedRequest: AgentRunRequest<InterviewRehearsalInput, unknown> | undefined;
  let preparedInput: InterviewRehearsalInput | undefined;
  const executor: AgentExecutor<InterviewRehearsalInput> = {
    startRun: vi.fn(async (request) => {
      preparedRequest = request;
      const prepared = await request.prepareRun({ runId: "run-1", eventRevision: 0 });
      preparedInput = prepared.input;
      return {
        runId: "run-1",
        eventRevision: 0,
        prepared: prepared.prepared,
        result: Promise.resolve(undefined),
        done: Promise.resolve("completed" as const),
      };
    }),
  };
  const agentRuntime = {
    cancel: vi.fn(),
    waitForRun: vi.fn(async () => undefined),
    getRun: vi.fn(async () => undefined),
    readEventsForRun: vi.fn(async () => [] as AgentEventEnvelope[]),
    readEvents: vi.fn(async () => [] as AgentEventEnvelope[]),
  } as unknown as ConstructorParameters<typeof InterviewApplication>[0]["agentRuntime"];
  const app = new InterviewApplication({
    agentRuntime,
    store,
    executor,
    authorAgentId: INTERVIEW_REHEARSAL_AGENT_ID,
    requestAccessToken: vi.fn(async () => "token"),
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
    executor,
    getPrepared: () => preparedRequest,
    getInput: () => preparedInput,
  };
}

describe("InterviewApplication", () => {
  it("writes the user turn, publishes its snapshot, and starts the interview Agent", async () => {
    const { app, snapshots, getPrepared } = createHarness();

    await app.createConversation("conversation-1");
    app.start();
    await app.turnSettled("conversation-1", [turn()], "请自我介绍");

    expect(snapshots).toHaveLength(2);
    expect((snapshots[0] as { messages: Array<{ role: string; text: string }> }).messages).toEqual([
      expect.objectContaining({ role: "user", text: "请自我介绍" }),
    ]);
    expect((snapshots[1] as { messages: Array<{ role: string }> }).messages.at(-1)?.role).toBe(
      "assistant",
    );
    const preparedRequest = getPrepared();
    expect(preparedRequest).toBeDefined();
    if (!preparedRequest) throw new Error("missing prepared request");
    expect(await preparedRequest.getAccessToken()).toBe("token");
  });

  it("sends rehearsal text through the same reply path with memory context", async () => {
    const { app, snapshots, getInput } = createHarness();

    await app.createConversation("conversation-1");
    const result = await app.sendText("conversation-1", "帮我看一下简历");

    expect(result.runId).toBe("run-1");
    expect(snapshots).toHaveLength(2);
    expect((snapshots[0] as { messages: Array<{ role: string; text: string }> }).messages).toEqual([
      expect.objectContaining({ role: "user", text: "帮我看一下简历" }),
    ]);
    expect(getInput()).toEqual(
      expect.objectContaining({
        workspaceRoot: "C:/workspace",
        interviewDataRoot: "C:/data/interview",
      }),
    );
  });
});
