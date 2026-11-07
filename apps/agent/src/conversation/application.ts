/** Conversation application：处理聊天用例、transcript 回合认领和注册 Agent 的执行接线。 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEventEnvelope, AgentRunSnapshot, RunOutcome } from "@answra/shared/schema";
import type { AgentExecutor, AgentRunPrepared } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import { validateModelRequest } from "../core/model/requestContent";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationStore } from "../core/transcript/store";
import type { ConversationAgentInput, ConversationAgentProfile } from "./agent";
import { CHAT_PROFILES, type ChatProfileId } from "./profiles/registry";

/** 对话用例依赖 AgentRuntime 的已注册 executor 与 transcript 仓储。 */
export interface ConversationApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  conversationAgent?: AgentExecutor<ConversationAgentInput>;
}

export class ConversationApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly conversationAgent?: AgentExecutor<ConversationAgentInput>;
  private workspaceRoot: string | null = null;

  constructor({ agentRuntime, store, conversationAgent }: ConversationApplicationOptions) {
    this.agentRuntime = agentRuntime;
    this.store = store;
    this.conversationAgent = conversationAgent;
  }

  setWorkspaceRoot(root: string | null): void {
    this.workspaceRoot = root;
  }

  getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.loadRecoverySnapshot(conversationId);
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

  readEventsAfter(conversationId: string, revision: number): Promise<AgentEventEnvelope[]> {
    return this.agentRuntime.readEvents(conversationId, revision);
  }

  async createConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.create(conversationId);
    return this.loadRecoverySnapshot(conversationId);
  }

  /** 用户显式清空会话；仓储只允许清空空闲会话，并返回清空后的 snapshot。 */
  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    const eventRevision = await this.agentRuntime.getConversationRevision(conversationId);
    await this.store.clear(conversationId, eventRevision);
    return this.loadRecoverySnapshot(conversationId);
  }

  async appendUserMessage(conversationId: string, text: string): Promise<ConversationSnapshot> {
    if (typeof text !== "string" || !text.trim() || text.length > 32_000)
      throw new Error("消息内容无效或过长");
    return this.store.appendUserMessage(
      conversationId,
      createUserMessage(randomUUID(), { text: text.trim(), images: [] }),
    );
  }

  configure(config: ConversationModelConfig): void {
    this.agentRuntime.configureModelRoutes({ chat: config.chat, answer: config.answer });
  }

  async sendChat(
    profileId: ChatProfileId,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const profile = CHAT_PROFILES[profileId];
    if (!profile) throw new Error("未授权的对话能力配置");
    return this.startChatRun(profile, conversationId, request, accessToken);
  }

  async replyToLastUser(
    profileId: ChatProfileId,
    conversationId: string,
    getAccessToken: () => Promise<string>,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const profile = CHAT_PROFILES[profileId];
    if (!profile) throw new Error("未授权的对话能力配置");
    return this.replyWithProfile(profile, conversationId, getAccessToken);
  }

  private replyWithProfile(
    profile: ConversationAgentProfile,
    conversationId: string,
    getAccessToken: () => Promise<string>,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    return this.startConversationRun({
      conversationId,
      executor: this.requireConversationAgent(),
      getAccessToken,
      prepareRun: async ({ runId, eventRevision }) => {
        const target = await this.store.beginReplyRun(conversationId, runId, eventRevision);
        return {
          input: {
            conversationId,
            request: { text: target.text, images: target.images },
            profile,
            workspaceRoot: this.workspaceRoot,
          },
          snapshot: await this.loadRecoverySnapshot(conversationId),
        };
      },
    });
  }

  private async startChatRun(
    profile: ConversationAgentProfile,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    validateModelRequest(request);
    return this.startConversationRun({
      conversationId,
      executor: this.requireConversationAgent(),
      getAccessToken: async () => accessToken,
      prepareRun: async ({ runId, eventRevision }) => {
        await this.store.create(conversationId);
        await this.store.beginRun(
          conversationId,
          runId,
          createUserMessage(randomUUID(), request),
          eventRevision,
        );
        return {
          input: { conversationId, request, profile, workspaceRoot: this.workspaceRoot },
          snapshot: await this.loadRecoverySnapshot(conversationId),
        };
      },
    });
  }

  private async startConversationRun<Input>({
    conversationId,
    executor,
    getAccessToken,
    prepareRun,
    onRunPrepared,
  }: {
    conversationId: string;
    executor: AgentExecutor<Input>;
    getAccessToken: () => Promise<string>;
    prepareRun: (
      run: AgentRunPrepared,
    ) => Promise<{ input: Input; snapshot: ConversationSnapshot }>;
    onRunPrepared?: (snapshot: ConversationSnapshot) => Promise<void>;
  }): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const handle = await executor.startRun({
      conversationId,
      getAccessToken,
      prepareRun: async (run) => {
        const prepared = await prepareRun(run);
        await onRunPrepared?.(prepared.snapshot);
        return { input: prepared.input, prepared: prepared.snapshot };
      },
      onEvent: (event) => this.applyRunEvent(conversationId, event),
    });
    return { runId: handle.runId, snapshot: handle.prepared };
  }

  private async applyRunEvent(conversationId: string, envelope: AgentEventEnvelope): Promise<void> {
    const { event, runId, aggregateRevision } = envelope;
    if (event.type === "text-delta")
      await this.store.applyStreamEvent(conversationId, runId, event);
    if (event.type !== "run-state-changed") return;

    const outcome = runOutcomeForState(event.state);
    if (!outcome) return;
    await this.store.finishRun(conversationId, runId, outcome, aggregateRevision);
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

  dispose(): void {
    this.agentRuntime.dispose();
  }

  get activeRunCount(): number {
    return this.agentRuntime.activeRunCount;
  }

  private requireConversationAgent(): AgentExecutor<ConversationAgentInput> {
    if (!this.conversationAgent) throw new Error("Conversation Agent 未注册");
    return this.conversationAgent;
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
