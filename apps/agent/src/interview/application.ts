/** Interview application：拥有候选人 turn 的 transcript 写入、回复 run 与 snapshot 发布。 */
import { randomUUID } from "node:crypto";
import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope, AgentRunSnapshot, RunOutcome } from "@answra/shared/schema";
import type { AgentExecutor } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationStore } from "../core/transcript/store";
import type { InterviewReplyInput } from "./agent";
import type { CommittedInterviewTurn } from "./contracts";
import { InterviewReplyLoop } from "./reply/loop";

export interface InterviewApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  executor: AgentExecutor<InterviewReplyInput>;
  requestAccessToken: () => Promise<string>;
  onSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
  onTurnCommitted: (turn: CommittedInterviewTurn) => void;
  onError: (stage: "append" | "reply", error: unknown) => void;
}

export class InterviewApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly executor: AgentExecutor<InterviewReplyInput>;
  private readonly requestAccessToken: () => Promise<string>;
  private readonly onSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
  private readonly replyLoop: InterviewReplyLoop;

  constructor(options: InterviewApplicationOptions) {
    this.agentRuntime = options.agentRuntime;
    this.store = options.store;
    this.executor = options.executor;
    this.requestAccessToken = options.requestAccessToken;
    this.onSnapshot = options.onSnapshot;
    this.replyLoop = new InterviewReplyLoop({
      ports: {
        appendUserTurn: (conversationId, turns, text) =>
          this.appendUserTurn(conversationId, turns, text, options.onTurnCommitted),
        startReply: (conversationId) => this.startReply(conversationId),
        cancelReply: (runId) => this.agentRuntime.cancel(runId),
        waitForReply: (runId) => this.agentRuntime.waitForRun(runId),
        onError: options.onError,
      },
    });
  }

  start(): void {
    this.replyLoop.start();
  }

  turnSettled(
    conversationId: string,
    turns: readonly CommittedInterviewTurn[],
    text: string,
  ): Promise<void> {
    return this.replyLoop.turnSettled(conversationId, turns, text);
  }

  stop(): Promise<void> {
    return this.replyLoop.stop();
  }

  getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.loadRecoverySnapshot(conversationId);
  }

  async createConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.create(conversationId);
    return this.loadRecoverySnapshot(conversationId);
  }

  cancel(runId: string): void {
    this.agentRuntime.cancel(runId);
  }

  waitForRun(runId: string): Promise<void> {
    return this.agentRuntime.waitForRun(runId);
  }

  getExecutionRun(runId: string): Promise<AgentRunSnapshot | undefined> {
    return this.agentRuntime.getRun(runId);
  }

  readExecutionEvents(runId: string): Promise<AgentEventEnvelope[]> {
    return this.agentRuntime.readEventsForRun(runId);
  }

  private async appendUserTurn(
    conversationId: string,
    turns: readonly CommittedInterviewTurn[],
    text: string,
    onTurnCommitted: (turn: CommittedInterviewTurn) => void,
  ): Promise<void> {
    const snapshot = await this.store.appendUserMessage(
      conversationId,
      createUserMessage(randomUUID(), { text, images: [] }),
    );
    await this.onSnapshot(snapshot);
    for (const turn of turns) onTurnCommitted(turn);
  }

  private async startReply(conversationId: string): Promise<{ runId: string }> {
    const handle = await this.executor.startRun({
      conversationId,
      getAccessToken: this.requestAccessToken,
      prepareRun: async ({ runId, eventRevision }) => {
        await this.store.beginReplyRun(conversationId, runId, eventRevision);
        const snapshot = await this.loadRecoverySnapshot(conversationId);
        await this.onSnapshot(snapshot);
        return { input: { conversationId }, prepared: snapshot };
      },
      onEvent: (event) => this.applyRunEvent(conversationId, event),
    });
    return { runId: handle.runId };
  }

  private async loadRecoverySnapshot(conversationId: string): Promise<ConversationSnapshot> {
    const snapshot = await this.store.load(conversationId);
    const events = await this.agentRuntime.readEvents(conversationId, snapshot.eventRevision);
    const latestAssistant = [...snapshot.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!latestAssistant || snapshot.activeRunId !== latestAssistant.id) return snapshot;
    if (!events.some((event) => event.runId === latestAssistant.id)) return snapshot;
    return {
      ...snapshot,
      messages: snapshot.messages.map((message) =>
        message.id === latestAssistant.id
          ? { ...message, text: "", status: "streaming" as const }
          : message,
      ),
    };
  }

  private async applyRunEvent(conversationId: string, envelope: AgentEventEnvelope): Promise<void> {
    const { event, runId, aggregateRevision } = envelope;
    if (event.type === "text-delta")
      await this.store.applyStreamEvent(conversationId, runId, event);
    if (event.type !== "run-state-changed") return;
    const outcome = runOutcomeForState(event.state);
    if (outcome) await this.store.finishRun(conversationId, runId, outcome, aggregateRevision);
  }
}

function runOutcomeForState(state: string): RunOutcome | undefined {
  switch (state) {
    case "completed":
    case "failed":
    case "aborted":
      return state;
    case "superseded":
      return "superseded";
    default:
      return undefined;
  }
}
