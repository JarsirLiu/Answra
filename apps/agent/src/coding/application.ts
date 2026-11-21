/** CLI coding 单 Bot 会话用例：创建、发送、取消与 transcript 更新；不包含 team/handoff。 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSendResult,
  ConversationSnapshot,
  ManualCompactionResult,
} from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import type { AgentRunHandle } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import { ContextCompactor } from "../core/context/compaction/compactor";
import { ContextPreparation } from "../core/context/preparation";
import { validateModelRequest } from "../core/model/requestContent";
import { TurnQueueRegistry } from "../core/queue/turnQueueRegistry";
import { createUserMessage } from "../core/transcript/message";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStore,
} from "../core/transcript/store";
import type { CodingAgentInput } from "./agent";
import type { CodingBot } from "./bot";

const MANUAL_COMPACTION_AGENT_RUN = "manual-compaction";

export interface CodingApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  bot: CodingBot;
  /** 每段 run 启动后的权威 snapshot 推送。 */
  onSnapshot?: (snapshot: ConversationSnapshot) => void | Promise<void>;
}

export class CodingApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly bot: CodingBot;
  private readonly contextCompactor: ContextCompactor;
  private readonly contextPreparation: ContextPreparation;
  private readonly onSnapshot?: CodingApplicationOptions["onSnapshot"];
  private readonly turns = new TurnQueueRegistry();
  private closing = false;
  private workspaceRoot: string | null = null;

  constructor({ agentRuntime, store, bot, onSnapshot }: CodingApplicationOptions) {
    if (bot.domain !== "coding") throw new Error(`不是 coding Bot：${bot.id}`);
    this.agentRuntime = agentRuntime;
    this.store = store;
    this.bot = bot;
    this.onSnapshot = onSnapshot;
    this.contextCompactor = new ContextCompactor({
      store,
      generate: ({ prompt, accessToken, signal }) =>
        agentRuntime.generateText({
          prompt,
          accessToken,
          ...(signal ? { signal } : {}),
        }),
      ...(onSnapshot ? { onSnapshot } : {}),
    });
    this.contextPreparation = new ContextPreparation({
      compactor: this.contextCompactor,
      contextStateStore: store,
      contextWindow: () => this.agentRuntime.chatContextWindow(),
    });
  }

  setWorkspaceRoot(root: string | null): void {
    this.workspaceRoot = root;
  }

  private sessionMetadata(): ConversationSessionMetadata {
    return {
      scope: "coding",
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
    };
  }

  async createConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.create(conversationId, this.seed(), this.sessionMetadata());
    return this.store.load(conversationId);
  }

  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    this.turns.cancelPending(conversationId);
    const eventRevision = await this.agentRuntime.getConversationRevision(conversationId);
    await this.store.clear(conversationId, eventRevision);
    return this.store.load(conversationId);
  }

  async compactConversation(
    conversationId: string,
    accessToken: string,
    { signal, instructions }: { signal?: AbortSignal; instructions?: string } = {},
  ): Promise<{ result: ManualCompactionResult; snapshot: ConversationSnapshot }> {
    if (this.agentRuntime.activeRunCount > 0) throw new Error("上一轮尚未结束");
    if (this.hasQueuedMessages(conversationId)) throw new Error("仍有排队消息");
    const controller = new AbortController();
    const abortSignal = signal ?? controller.signal;
    const input = this.manualCompactionInput(conversationId);
    const modelRequest = await this.bot.executor.prepare(input, abortSignal);
    const result = await this.contextPreparation.compactNow({
      conversationId,
      getAccessToken: async () => accessToken,
      modelRequest,
      rebuild: () => this.bot.executor.prepare(input, abortSignal),
      signal: abortSignal,
      ...(instructions === undefined ? {} : { compactionInstructions: instructions }),
      onStatus: async () => this.pushSnapshotValue(await this.store.load(conversationId)),
    });
    return { result, snapshot: await this.store.load(conversationId) };
  }

  getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.store.load(conversationId);
  }

  readEventsAfter(conversationId: string, revision: number): Promise<AgentEventEnvelope[]> {
    return this.agentRuntime.readEvents(conversationId, revision);
  }

  async enqueue(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<ConversationSendResult> {
    validateModelRequest(request);
    if (!request.text.trim() && request.images.length === 0) throw new Error("消息内容不能为空");
    await this.store.create(conversationId, this.seed(), this.sessionMetadata());
    const getAccessToken = async () => accessToken;
    return this.turns.enqueue(conversationId, async () => {
      const handle = await this.startRun({ conversationId, request, getAccessToken });
      this.turns.trackRun(conversationId, handle.runId);
      const completion = this.agentRuntime.waitForRun(handle.runId).then(async () => {
        this.turns.untrackRun(handle.runId);
        return "completed" as const;
      });
      return { runId: handle.runId, snapshot: handle.prepared, completion };
    });
  }

  async send(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const accepted = await this.enqueue(conversationId, request, accessToken);
    if (accepted.status === "started") {
      return { runId: accepted.runId, snapshot: accepted.snapshot };
    }
    const started = await this.turns.waitForStart(conversationId, accepted.queueId);
    return { runId: started.runId, snapshot: started.snapshot };
  }

  configure(config: ConversationModelConfig): void {
    this.agentRuntime.configureModelRoutes({ chat: config.chat, answer: config.answer });
  }

  cancel(runId: string): void {
    const conversationId = this.turns.conversationForRun(runId);
    if (conversationId !== undefined) {
      this.turns.cancelPending(conversationId);
      const activeRunId = this.turns.activeRunId(conversationId);
      if (activeRunId !== undefined && activeRunId !== runId) {
        this.agentRuntime.cancel(activeRunId);
      }
    }
    this.agentRuntime.cancel(runId);
  }

  waitForQueue(conversationId: string, queueId: string) {
    return this.turns.wait(conversationId, queueId);
  }

  waitForQueueStart(conversationId: string, queueId: string) {
    return this.turns.waitForStart(conversationId, queueId);
  }

  getQueuePosition(conversationId: string, queueId: string): number | undefined {
    return this.turns.position(conversationId, queueId);
  }

  waitForRun(runId: string): Promise<void> {
    return this.agentRuntime.waitForRun(runId);
  }

  /** 关闭队列消费：只阻止/取消尚未启动的 turn，活动 run 由调用方统一 abort。 */
  cancelPendingTurns(): void {
    this.closing = true;
    this.turns.dispose();
  }

  dispose(): void {
    this.closing = true;
    this.turns.dispose();
    this.agentRuntime.dispose();
  }

  get activeRunCount(): number {
    return this.agentRuntime.activeRunCount;
  }

  private manualCompactionInput(conversationId: string): CodingAgentInput {
    return {
      conversationId,
      runId: MANUAL_COMPACTION_AGENT_RUN,
      request: { text: "", images: [] },
      policy: this.bot.policy,
      workspaceRoot: this.workspaceRoot,
    };
  }

  private hasQueuedMessages(conversationId: string): boolean {
    return this.turns.hasQueued(conversationId);
  }

  private startRun({
    conversationId,
    request,
    getAccessToken,
  }: {
    conversationId: string;
    request: ConversationSendRequest;
    getAccessToken: () => Promise<string>;
  }): Promise<AgentRunHandle<ConversationSnapshot>> {
    if (this.closing) throw new Error("会话正在关闭");
    return this.bot.executor.startRun<ConversationSnapshot>({
      conversationId,
      getAccessToken,
      shouldYield: () => this.turns.queuedCount(conversationId) > 0,
      prepareContext: (modelRequest, rebuild, signal) =>
        this.contextPreparation.prepareRequest({
          conversationId,
          getAccessToken,
          modelRequest,
          rebuild,
          signal,
          onStatus: async () => this.pushSnapshotValue(await this.store.load(conversationId)),
        }),
      recoverContext: (modelRequest, rebuild, _error, signal) =>
        this.contextPreparation.recoverRequest({
          conversationId,
          getAccessToken,
          modelRequest,
          rebuild,
          signal,
          onStatus: async () => this.pushSnapshotValue(await this.store.load(conversationId)),
        }),
      prepareRun: async ({ runId, eventRevision }) => {
        await this.store.beginRun(
          conversationId,
          runId,
          createUserMessage(randomUUID(), request),
          eventRevision,
          this.bot.id,
        );
        const snapshot = await this.store.load(conversationId);
        await this.pushSnapshotValue(snapshot);
        return {
          input: {
            conversationId,
            runId,
            request,
            policy: this.bot.policy,
            workspaceRoot: this.workspaceRoot,
          },
          prepared: snapshot,
        };
      },
      onEvent: (event) => this.applyRunEvent(conversationId, event),
    });
  }

  private seed(): ConversationSessionSeed {
    return {
      activeAgentId: this.bot.id,
      participantAgentIds: [this.bot.id],
      bots: [{ id: this.bot.id, name: this.bot.identity.name, role: this.bot.identity.role }],
    };
  }

  private async pushSnapshotValue(snapshot: ConversationSnapshot): Promise<void> {
    if (!this.onSnapshot) return;
    await this.onSnapshot(snapshot);
  }

  private async applyRunEvent(conversationId: string, envelope: AgentEventEnvelope): Promise<void> {
    await this.store.applyAgentEvent(conversationId, envelope);
    await this.contextPreparation.recordRunEvent(conversationId, envelope.event);
  }
}
