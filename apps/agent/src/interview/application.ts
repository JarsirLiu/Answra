/** Interview application：拥有演练文本/语音回合、transcript 写入、回复 run 与 snapshot 发布。 */
import { randomUUID } from "node:crypto";
import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope, AgentRunSnapshot } from "@answra/shared/schema";
import type { AgentExecutor, AgentId } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import type { ReadFileStateMap } from "../core/tool";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationStore } from "../core/transcript/store";
import type { InterviewRehearsalInput } from "./agent";
import type { CommittedInterviewTurn } from "./contracts";
import { InterviewReplyLoop } from "./reply/loop";

export interface InterviewApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  executor: AgentExecutor<InterviewRehearsalInput>;
  /** 面试演练回复的 assistant 消息归属。 */
  authorAgentId: AgentId;
  requestAccessToken: () => Promise<string>;
  onSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
  onTurnCommitted: (turn: CommittedInterviewTurn) => void;
  onError: (stage: "append" | "reply", error: unknown) => void;
}

export class InterviewApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly executor: AgentExecutor<InterviewRehearsalInput>;
  private readonly authorAgentId: AgentId;
  private readonly requestAccessToken: () => Promise<string>;
  private readonly onSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
  private readonly replyLoop: InterviewReplyLoop;
  private readonly readFileStates = new Map<string, ReadFileStateMap>();
  private workspaceRoot: string | null = null;
  private interviewDataRoot: string | null = null;

  constructor(options: InterviewApplicationOptions) {
    this.agentRuntime = options.agentRuntime;
    this.store = options.store;
    this.executor = options.executor;
    this.authorAgentId = options.authorAgentId;
    this.requestAccessToken = options.requestAccessToken;
    this.onSnapshot = options.onSnapshot;
    this.replyLoop = new InterviewReplyLoop({
      ports: {
        appendUserTurn: (conversationId, turns, text) =>
          this.appendUserTurn(conversationId, turns, text, options.onTurnCommitted),
        startReply: async (conversationId) => {
          const { runId } = await this.startReply(conversationId);
          return { runId };
        },
        cancelReply: (runId) => this.agentRuntime.cancel(runId),
        waitForReply: (runId) => this.agentRuntime.waitForRun(runId),
        onError: options.onError,
      },
    });
  }

  setWorkspaceRoot(root: string | null): void {
    this.workspaceRoot = root;
  }

  setInterviewDataRoot(root: string | null): void {
    this.interviewDataRoot = root;
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

  /** 演练文本输入：先落 user 消息，再用同一 Agent 开始回复。 */
  async sendText(
    conversationId: string,
    text: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 32_000) throw new Error("演练消息无效或过长");
    const appended = await this.store.appendUserMessage(
      conversationId,
      createUserMessage(randomUUID(), { text: trimmed, images: [] }),
    );
    await this.onSnapshot(appended);
    return this.startReply(conversationId);
  }

  stop(): Promise<void> {
    return this.replyLoop.stop();
  }

  getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.loadRecoverySnapshot(conversationId);
  }

  async createConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.create(conversationId);
    this.readFileStates.delete(conversationId);
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

  private async startReply(
    conversationId: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const handle = await this.executor.startRun<ConversationSnapshot>({
      conversationId,
      getAccessToken: this.requestAccessToken,
      prepareRun: async ({ runId, eventRevision }) => {
        await this.store.beginReplyRun(conversationId, runId, eventRevision, this.authorAgentId);
        const snapshot = await this.loadRecoverySnapshot(conversationId);
        await this.onSnapshot(snapshot);
        return {
          input: {
            conversationId,
            runId,
            workspaceRoot: this.workspaceRoot,
            interviewDataRoot: this.interviewDataRoot,
            readFileState: this.getReadFileState(conversationId),
          },
          prepared: snapshot,
        };
      },
      onEvent: (event) => this.applyRunEvent(conversationId, event),
    });
    return { runId: handle.runId, snapshot: handle.prepared };
  }

  private async loadRecoverySnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.store.load(conversationId);
  }

  private async applyRunEvent(conversationId: string, envelope: AgentEventEnvelope): Promise<void> {
    await this.store.applyAgentEvent(conversationId, envelope);
  }

  private getReadFileState(conversationId: string): ReadFileStateMap {
    const existing = this.readFileStates.get(conversationId);
    if (existing) return existing;
    const state: ReadFileStateMap = new Map();
    this.readFileStates.set(conversationId, state);
    return state;
  }
}
