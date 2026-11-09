/** Conversation application：处理聊天用例、transcript 回合认领和注册 Agent 的执行接线。 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEventEnvelope, AgentRunSnapshot } from "@answra/shared/schema";
import type { AgentExecutor, AgentRunPrepared } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import { validateModelRequest } from "../core/model/requestContent";
import type { ReadFileStateMap } from "../core/tool";
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
  private readonly readFileStates = new Map<string, ReadFileStateMap>();
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
    return this.store.load(conversationId);
  }

  readEventsAfter(conversationId: string, revision: number): Promise<AgentEventEnvelope[]> {
    return this.agentRuntime.readEvents(conversationId, revision);
  }

  async createConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.create(conversationId);
    this.readFileStates.delete(conversationId);
    return this.loadRecoverySnapshot(conversationId);
  }

  /** 用户显式清空会话；仓储只允许清空空闲会话，并返回清空后的 snapshot。 */
  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    const eventRevision = await this.agentRuntime.getConversationRevision(conversationId);
    await this.store.clear(conversationId, eventRevision);
    this.readFileStates.delete(conversationId);
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
            runId,
            request: { text: target.text, images: target.images },
            profile,
            workspaceRoot: this.workspaceRoot,
            readFileState: this.getReadFileState(conversationId),
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
          input: {
            conversationId,
            runId,
            request,
            profile,
            workspaceRoot: this.workspaceRoot,
            readFileState: this.getReadFileState(conversationId),
          },
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
    await this.store.applyAgentEvent(conversationId, envelope);
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
    this.readFileStates.clear();
    this.agentRuntime.dispose();
  }

  get activeRunCount(): number {
    return this.agentRuntime.activeRunCount;
  }

  private getReadFileState(conversationId: string): ReadFileStateMap {
    const existing = this.readFileStates.get(conversationId);
    if (existing) return existing;
    const state: ReadFileStateMap = new Map();
    this.readFileStates.set(conversationId, state);
    return state;
  }

  private requireConversationAgent(): AgentExecutor<ConversationAgentInput> {
    if (!this.conversationAgent) throw new Error("Conversation Agent 未注册");
    return this.conversationAgent;
  }
}
