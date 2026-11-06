/** Conversation 组合根：提供会话操作，并原子认领一次 assistant 回合。 */
import { randomUUID } from "node:crypto";
import type {
  ConversationCapabilityEndpoint,
  ConversationChange,
  ConversationModelConfig,
  ConversationSendRequest,
} from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import type { ToolSet } from "ai";
import { RunRegistry } from "../../core/run/registry";
import { MemoryExecutionStore } from "../../execution/memoryStore";
import type { ExecutionStore } from "../../execution/store";
import { ANSWER_PROFILE } from "../profiles/answer";
import { MemoryConversationStore } from "../session/memoryStore";
import { createUserMessage } from "../session/message";
import type { ConversationStore } from "../session/store";
import type { ConversationToolId } from "../tools/types";
import { validateEndpoint } from "./endpointFetch";
import { executeTurn } from "./executeTurn";
import { validateRequest } from "./requestContent";

/** 会话仓储订阅与一次 assistant 回合的认领、取消、等待入口。 */
export interface ConversationRuntimeOptions {
  emit: (change: ConversationChange) => void;
  emitExecution?: (event: AgentEventEnvelope) => void;
  store?: ConversationStore;
  executionStore?: ExecutionStore;
  createTools: (
    authorizedIds: readonly ConversationToolId[],
    context: { workspaceRoot: string | null; signal: AbortSignal },
  ) => ToolSet | undefined;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
}

/**
 * Conversation 领域组合根：管理会话操作并认领回合。
 * AI SDK 流处理、HTTP 认证和完成落账由 executeTurn 负责。
 */
export class ConversationRuntime {
  private config?: ConversationModelConfig;
  private readonly runs = new RunRegistry();
  private readonly store: ConversationStore;
  private readonly executionStore: ExecutionStore;
  private readonly unsubscribeStore: () => void;
  private readonly unsubscribeExecution: () => void;
  private readonly tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  private readonly createTools: ConversationRuntimeOptions["createTools"];
  private workspaceRoot: string | null = null;

  constructor({
    emit,
    emitExecution,
    store = new MemoryConversationStore(),
    executionStore = new MemoryExecutionStore(),
    createTools,
    tokenProvider,
  }: ConversationRuntimeOptions) {
    this.store = store;
    this.executionStore = executionStore;
    this.tokenProvider = tokenProvider;
    this.createTools = createTools;
    this.unsubscribeStore = store.subscribe(emit);
    this.unsubscribeExecution = emitExecution
      ? executionStore.subscribe(emitExecution)
      : () => undefined;
  }

  setWorkspaceRoot(root: string | null): void {
    this.workspaceRoot = root;
  }

  getSnapshot(conversationId: string) {
    return this.store.load(conversationId);
  }

  readEventsAfter(conversationId: string, revision: number) {
    return this.store.readAfter(conversationId, revision);
  }

  async createConversation(conversationId: string) {
    return this.store.create(conversationId);
  }

  /** 用户显式清空会话；仓储只允许清空空闲会话。 */
  async clearConversation(conversationId: string): Promise<void> {
    await this.store.clear(conversationId);
  }

  async appendUserMessage(conversationId: string, text: string): Promise<void> {
    if (typeof text !== "string" || !text.trim() || text.length > 32_000)
      throw new Error("消息内容无效或过长");
    await this.store.appendUserMessage(
      conversationId,
      createUserMessage(randomUUID(), { text: text.trim(), images: [] }),
    );
  }

  configure(config: ConversationModelConfig): void {
    for (const endpoint of [config.chat, config.answer]) validateEndpoint(endpoint);
    this.config = { chat: { ...config.chat }, answer: { ...config.answer } };
  }

  async runAnswer(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string }> {
    return this.startRun({
      conversationId,
      request,
      accessToken,
      systemPrompt: ANSWER_PROFILE.systemPrompt,
      includeHistory: false,
      ephemeral: true,
      injectTime: false,
      authorizedTools: [],
    });
  }

  protected async startRun(options: {
    conversationId: string;
    request: ConversationSendRequest;
    accessToken: string;
    systemPrompt: string;
    includeHistory: boolean;
    ephemeral: boolean;
    injectTime: boolean;
    authorizedTools: readonly ConversationToolId[];
  }): Promise<{ runId: string }> {
    const {
      conversationId,
      request,
      accessToken,
      systemPrompt,
      includeHistory,
      ephemeral,
      injectTime,
      authorizedTools,
    } = options;
    const config = this.requireConfig();
    validateRequest(request);

    const runId = randomUUID();
    const controller = new AbortController();
    const endpoint = ephemeral ? config.answer : config.chat;
    await this.store.create(conversationId);
    const userMessage = createUserMessage(randomUUID(), request);
    if (ephemeral) await this.store.beginEphemeralRun(conversationId, runId, userMessage);
    else await this.store.beginRun(conversationId, runId, userMessage);
    this.trackRun(runId, controller);
    this.executeClaimedTurn({
      conversationId,
      runId,
      endpoint,
      getAccessToken: async () => accessToken,
      request,
      controller,
      systemPrompt,
      includeHistory,
      ephemeral,
      injectTime,
      authorizedTools,
    });
    return { runId };
  }

  /** 对已经入 transcript 的最后一条用户消息认领 assistant 回合。 */
  async replyToLastUserWithProfile(
    profile: ReplyProfile,
    conversationId: string,
    getAccessToken: () => Promise<string>,
  ): Promise<{ runId: string }> {
    const config = this.requireConfig();
    const runId = randomUUID();
    const controller = new AbortController();
    const target = await this.store.beginReplyRun(conversationId, runId);
    this.trackRun(runId, controller);
    this.executeClaimedTurn({
      conversationId,
      runId,
      endpoint: config.chat,
      getAccessToken,
      request: { text: target.text, images: target.images },
      controller,
      systemPrompt: profile.systemPrompt,
      includeHistory: profile.includeHistory,
      ephemeral: false,
      injectTime: profile.injectTime ?? false,
      authorizedTools: profile.tools,
    });
    return { runId };
  }

  private executeClaimedTurn(options: {
    conversationId: string;
    runId: string;
    endpoint: ConversationCapabilityEndpoint;
    getAccessToken: () => Promise<string>;
    request: ConversationSendRequest;
    controller: AbortController;
    systemPrompt: string;
    includeHistory: boolean;
    ephemeral: boolean;
    injectTime: boolean;
    authorizedTools: readonly ConversationToolId[];
  }): void {
    void executeTurn({
      ...options,
      tokenProvider: this.tokenProvider,
      workspaceRoot: this.workspaceRoot,
      store: this.store,
      executionStore: this.executionStore,
      createTools: this.createTools,
      onFinished: (runId) => this.runs.finish(runId),
    });
  }

  private trackRun(runId: string, controller: AbortController): void {
    this.runs.register(runId, controller);
  }

  cancel(runId: string): void {
    this.runs.cancel(runId);
  }

  waitForRun(runId: string): Promise<void> {
    return this.runs.wait(runId);
  }

  getExecutionRun(runId: string) {
    return this.executionStore.getRun(runId);
  }

  readExecutionEvents(runId: string) {
    return this.executionStore.readEvents(runId);
  }

  dispose(): void {
    this.runs.abortAll();
    this.unsubscribeStore();
    this.unsubscribeExecution();
  }

  get activeRunCount(): number {
    return this.runs.activeCount;
  }

  private requireConfig(): ConversationModelConfig {
    if (!this.config) throw new Error("云端模型服务尚未就绪");
    return this.config;
  }
}

/** 不同 Conversation 用例可以声明自己的提示词、历史和工具权限。 */
export interface ReplyProfile {
  systemPrompt: string;
  includeHistory: boolean;
  injectTime?: boolean;
  tools: readonly ConversationToolId[];
}
