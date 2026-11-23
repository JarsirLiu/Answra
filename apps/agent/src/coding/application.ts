/**
 * CLI coding 单 Bot 会话用例：Session 底座拥有 Turn/Step 状态与恢复，
 * transcript 继续负责历史展示；本文件只做领域装配与宿主端口接线。
 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSendResult,
  ConversationSnapshot,
  ManualCompactionResult,
} from "@answra/shared";
import type { SessionFrame, TurnOutcome } from "@answra/shared/schema";
import { ProviderStepRunner } from "../core/agent/providerStepRunner";
import type { AgentRuntime } from "../core/agent/runtime";
import { ContextCompactor } from "../core/context/compaction/compactor";
import { ContextPreparation } from "../core/context/preparation";
import { PreparationStepContextManager } from "../core/context/stepContextManager";
import { validateModelRequest } from "../core/model/requestContent";
import type { SessionCompactionRequest, SessionId, StepRunner } from "../core/session/contracts";
import { sessionId as asSessionId, turnId as asTurnId } from "../core/session/contracts";
import { SessionItemRecorder } from "../core/session/itemRecorder";
import { SessionRecoveryCoordinator } from "../core/session/recoveryCoordinator";
import { sessionErrorText } from "../core/session/sessionErrorText";
import { SessionFrameBus } from "../core/session/sessionFrameBus";
import { SessionRuntime } from "../core/session/sessionRuntime";
import { SessionStepExecutor } from "../core/session/stepExecutor";
import { SessionTurnExecutor } from "../core/session/turnExecutor";
import type { SessionItemStore } from "../core/transcript/itemStore";
import { MemorySessionItemStore } from "../core/transcript/memoryItemStore";
import { createUserMessage } from "../core/transcript/message";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStore,
} from "../core/transcript/store";
import type { CodingAgentInput } from "./agent";
import type { CodingBot } from "./bot";
import { createCodingStepBinding } from "./stepBinding";

const MANUAL_COMPACTION_AGENT_RUN = "manual-compaction";

export interface CodingApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  bot: CodingBot;
  /** durable 会话条目；缺省使用内存实现，CLI 宿主注入 SQLite 实现。 */
  sessionItems?: SessionItemStore;
  /** durable/live 帧广播口；宿主传入同一实例即可跨领域共享。 */
  sessionFrames?: SessionFrameBus;
  /** 测试注入的 StepRunner；生产由 ProviderStepRunner 提供。 */
  stepRunner?: StepRunner;
  /** 每段 run 启动后的权威 snapshot 推送。 */
  onSnapshot?: (snapshot: ConversationSnapshot) => void | Promise<void>;
}

export class CodingApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly bot: CodingBot;
  private readonly contextCompactor: ContextCompactor;
  private readonly contextPreparation: ContextPreparation;
  private readonly sessionFrames: SessionFrameBus;
  private readonly sessionRuntime: SessionRuntime;
  private readonly recovery: SessionRecoveryCoordinator;
  private readonly onSnapshot?: CodingApplicationOptions["onSnapshot"];
  private readonly tokens = new Map<string, () => Promise<string>>();
  private closing = false;
  private workspaceRoot: string | null = null;

  constructor({
    agentRuntime,
    store,
    bot,
    sessionItems,
    sessionFrames,
    stepRunner,
    onSnapshot,
  }: CodingApplicationOptions) {
    if (bot.domain !== "coding") throw new Error(`不是 coding Bot：${bot.id}`);
    this.agentRuntime = agentRuntime;
    this.store = store;
    this.bot = bot;
    this.onSnapshot = onSnapshot;
    this.sessionFrames = sessionFrames ?? new SessionFrameBus();
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
    const items = sessionItems ?? new MemorySessionItemStore();
    const recorder = new SessionItemRecorder({
      items,
      store,
      frames: this.sessionFrames,
      onSnapshot: (id) => this.pushSnapshot(id),
      onTurnFinished: (id, outcome) => this.contextPreparation.recordTurnFinished(id, outcome),
    });
    const binding = createCodingStepBinding({
      bot,
      workspaceRoot: () => this.workspaceRoot,
    });
    const runner =
      stepRunner ??
      new ProviderStepRunner({
        getEndpoint: () => this.agentRuntime.chatEndpoint(),
        prepare: binding.prepare,
        contextManager: new PreparationStepContextManager(this.contextPreparation),
        tokenProvider:
          typeof this.agentRuntime.modelTokenProvider === "function"
            ? this.agentRuntime.modelTokenProvider()
            : undefined,
      });
    const stepExecutor = new SessionStepExecutor({
      recorder,
      runner,
      onStepFinished: (step, result) =>
        this.contextPreparation.recordStepFinished(step.sessionId, {
          index: step.index,
          ...(result.usage?.inputTokens === undefined
            ? {}
            : { inputTokens: result.usage.inputTokens }),
        }),
    });
    const turnExecutor = new SessionTurnExecutor({
      recorder,
      stepExecutor,
      createMessageId: () => randomUUID(),
    });
    this.sessionRuntime = new SessionRuntime({
      items,
      store,
      recorder,
      executor: turnExecutor,
      compactor: {
        compact: (request, signal) => this.compactWithRuntime(request, signal),
      },
      // coding 只有一个 Bot，来源固定为用户消息。
      defaults: { agentId: bot.id, source: "user" },
      createMessageId: () => randomUUID(),
    });
    this.recovery = new SessionRecoveryCoordinator({
      recoverFacts: (id) => this.sessionRuntime.recoverFacts(id),
      refreshTranscript: (id) => this.sessionRuntime.refreshTranscript(id),
      resumeQueued: (id, runtime) => this.sessionRuntime.resumeQueued(id, runtime),
      onRecovered: async (id, plan) => {
        if (plan.closedTurnIds.length > 0) await this.pushSnapshot(id);
      },
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

  /** 打开/新建会话；带令牌时可在同一调用内恢复并继续消费 queued Turn。 */
  async createConversation(
    conversationId: string,
    accessToken?: string,
  ): Promise<ConversationSnapshot> {
    if (accessToken !== undefined) this.rememberToken(conversationId, accessToken);
    await this.store.create(conversationId, this.seed(), this.sessionMetadata());
    await this.sessionRuntime.createSession(asSessionId(conversationId));
    await this.ensureRecovered(conversationId);
    return this.loadSnapshot(conversationId);
  }

  async clearConversation(
    conversationId: string,
    accessToken?: string,
  ): Promise<ConversationSnapshot> {
    if (accessToken !== undefined) this.rememberToken(conversationId, accessToken);
    const session = await this.ensureRecovered(conversationId);
    await this.sessionRuntime.cancelSession(session);
    this.tokens.delete(conversationId);
    this.recovery.forget(session);
    await this.store.clear(conversationId);
    await this.sessionRuntime.clear(session);
    return this.loadSnapshot(conversationId);
  }

  async compactConversation(
    conversationId: string,
    accessToken: string,
    { signal, instructions }: { signal?: AbortSignal; instructions?: string } = {},
  ): Promise<{ result: ManualCompactionResult; snapshot: ConversationSnapshot }> {
    this.rememberToken(conversationId, accessToken);
    const session = await this.ensureRecovered(conversationId);
    if (await this.hasQueuedMessages(conversationId)) throw new Error("仍有排队消息");
    if (!this.bot.policy.includeHistory) throw new Error("当前 Bot 不保留历史，无法压缩");
    const result = await this.sessionRuntime.compact(session, {
      ...(instructions === undefined ? {} : { instructions }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (signal?.aborted) throw new Error("压缩已取消");
    return { result, snapshot: await this.loadSnapshot(conversationId) };
  }

  async getSnapshot(conversationId: string, accessToken?: string): Promise<ConversationSnapshot> {
    if (accessToken !== undefined) this.rememberToken(conversationId, accessToken);
    // 恢复必须由所属领域执行：其他领域（conversation/interview）可能共享同一 transcript 库。
    const scope = await this.store.scopeOf(conversationId);
    if (scope === undefined || scope === "coding") await this.ensureRecovered(conversationId);
    return this.loadSnapshot(conversationId);
  }

  /** 按 durable `seq` 读取条目帧；CLI 的 transcript 直接按帧折叠。 */
  async readFramesAfter(conversationId: string, afterSeq: number): Promise<SessionFrame[]> {
    return this.sessionRuntime.readFramesAfter(asSessionId(conversationId), afterSeq);
  }

  async enqueue(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<ConversationSendResult> {
    validateModelRequest(request);
    if (!request.text.trim() && request.images.length === 0) throw new Error("消息内容不能为空");
    if (this.closing) throw new Error("会话正在关闭");
    // 配置门禁必须在入队前完成，否则命令已返回成功、失败只发生在后台。
    if (this.agentRuntime.chatEndpoint !== undefined) this.agentRuntime.chatEndpoint();
    await this.store.create(conversationId, this.seed(), this.sessionMetadata());
    // 令牌必须先于恢复登记：恢复可能立即重跑上一进程留下的 queued Turn。
    this.rememberToken(conversationId, accessToken);
    const session = await this.ensureRecovered(conversationId);
    const submission = await this.sessionRuntime.submit({
      sessionId: session,
      source: "user",
      agentId: this.bot.id,
      input: createUserMessage(randomUUID(), request),
      runtime: { getAccessToken: async () => accessToken },
    });
    this.tokens.set(conversationId, async () => accessToken);
    const position = this.sessionRuntime.cachedPosition(session, submission.turnId);
    if (position !== 0 && position !== undefined) {
      return { queueId: submission.turnId, status: "queued", position };
    }
    return {
      queueId: submission.turnId,
      status: "started",
      position: 0,
      turnId: submission.turnId,
      snapshot: await this.loadSnapshot(conversationId),
    };
  }

  async send(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    const accepted = await this.enqueue(conversationId, request, accessToken);
    if (accepted.status === "started") {
      return { turnId: accepted.turnId, snapshot: accepted.snapshot };
    }
    return {
      turnId: accepted.queueId,
      snapshot: await this.loadSnapshot(conversationId),
    };
  }

  configure(config: ConversationModelConfig): void {
    this.agentRuntime.configureModelRoutes({ chat: config.chat, answer: config.answer });
  }

  cancel(conversationId: string, turnId: string): void {
    // 保留旧行为：取消一个 Turn 时同时清空该会话尚未开始的 Turn。
    void this.sessionRuntime
      .cancel(asSessionId(conversationId), asTurnId(turnId), { cancelQueued: true })
      .catch((error: unknown) => {
        console.warn("[coding] cancel failed", {
          turnId,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
  }

  waitForQueue(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; turnId?: string; outcome: TurnOutcome }> {
    return this.sessionRuntime
      .waitForTurn(asSessionId(conversationId), asTurnId(queueId))
      .then((completion) => ({
        queueId,
        turnId: queueId,
        outcome: completion.outcome,
      }));
  }

  waitForQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; turnId: string; snapshot: ConversationSnapshot }> {
    return this.sessionRuntime
      .waitForTurnStart(asSessionId(conversationId), asTurnId(queueId))
      .then(async () => ({
        queueId,
        turnId: queueId,
        snapshot: await this.loadSnapshot(conversationId),
      }));
  }

  getQueuePosition(conversationId: string, queueId: string): number | undefined {
    return this.sessionRuntime.cachedPosition(asSessionId(conversationId), asTurnId(queueId));
  }

  waitForTurn(conversationId: string, turnId: string): Promise<void> {
    return this.sessionRuntime
      .waitForTurn(asSessionId(conversationId), asTurnId(turnId))
      .then(() => undefined);
  }

  /** 关闭队列消费：只阻止/取消尚未启动的 turn，活动 Turn 由调用方统一 abort。 */
  cancelPendingTurns(): void {
    this.closing = true;
    this.sessionRuntime.dispose();
  }

  /** 退出屏障：阻止新 Turn 后等待活动/排队 Turn 的终态落盘。 */
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.sessionRuntime.shutdown();
  }

  dispose(): void {
    this.closing = true;
    this.sessionRuntime.dispose();
    this.agentRuntime.dispose();
  }

  private async ensureRecovered(conversationId: string): Promise<SessionId> {
    const id = asSessionId(conversationId);
    if (this.recovery.isRecovered(id)) return id;
    // 恢复会立即消费 queued Turn；没有令牌时必须显式失败，
    // 否则用户的排队消息会被烧成一条失败回复，而不是等模型可用后继续。
    if (!this.tokens.has(conversationId) && (await this.hasQueuedTurns(id))) {
      throw new Error("排队消息需要访问令牌才能继续");
    }
    await this.recovery.ensure(id, {
      getAccessToken: this.tokenProvider(conversationId),
    });
    return id;
  }

  private async hasQueuedTurns(sessionId: SessionId): Promise<boolean> {
    const projection = await this.sessionRuntime.snapshot(sessionId);
    return projection.turns.some((turn) => turn.status === "queued");
  }

  private rememberToken(conversationId: string, accessToken: string): void {
    this.tokens.set(conversationId, async () => accessToken);
  }

  private tokenProvider(conversationId: string): () => Promise<string> {
    return this.tokens.get(conversationId) ?? (() => Promise.reject(new Error("会话缺少访问令牌")));
  }

  private loadSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.store.load(conversationId);
  }

  private async compactWithRuntime(
    request: SessionCompactionRequest,
    signal: AbortSignal,
  ): Promise<ManualCompactionResult> {
    if (!this.bot.policy.includeHistory) {
      return { status: "failed", errorText: "当前 Bot 不保留历史，无法压缩" };
    }
    const conversationId = request.sessionId;
    const input = this.manualCompactionInput(conversationId);
    const prepare = () => this.bot.executor.prepare(input, signal);
    try {
      return await this.contextPreparation.compactNow({
        conversationId,
        operationId: request.operationId,
        getAccessToken: this.tokenProvider(conversationId),
        modelRequest: await prepare(),
        rebuild: prepare,
        signal,
        ...(request.instructions === undefined
          ? {}
          : { compactionInstructions: request.instructions }),
        onStatus: () => this.pushSnapshot(conversationId),
      });
    } catch (error) {
      return { status: "failed", errorText: sessionErrorText(error) };
    }
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

  private async hasQueuedMessages(conversationId: string): Promise<boolean> {
    return (await this.sessionRuntime.queuedCount(asSessionId(conversationId))) > 0;
  }

  private seed(): ConversationSessionSeed {
    return {
      activeAgentId: this.bot.id,
      participantAgentIds: [this.bot.id],
      bots: [{ id: this.bot.id, name: this.bot.identity.name, role: this.bot.identity.role }],
    };
  }

  private async pushSnapshot(conversationId: string): Promise<void> {
    await this.pushSnapshotValue(await this.loadSnapshot(conversationId));
  }

  private async pushSnapshotValue(snapshot: ConversationSnapshot): Promise<void> {
    if (!this.onSnapshot) return;
    await this.onSnapshot(snapshot);
  }
}
