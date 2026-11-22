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
import type {
  AgentEventEnvelope,
  AgentStreamEvent,
  SessionFrame,
  TurnOutcome,
} from "@answra/shared/schema";
import { toSessionFrame } from "@answra/shared/schema";
import { ProviderStepRunner } from "../core/agent/providerStepRunner";
import type { AgentRuntime } from "../core/agent/runtime";
import { ContextCompactor } from "../core/context/compaction/compactor";
import { ContextPreparation } from "../core/context/preparation";
import { PreparationStepContextManager } from "../core/context/stepContextManager";
import { validateModelRequest } from "../core/model/requestContent";
import type {
  SessionCompactionRequest,
  SessionId,
  StepRunner,
  StepStart,
} from "../core/session/contracts";
import { sessionId as asSessionId, turnId as asTurnId } from "../core/session/contracts";
import type { SessionJournal } from "../core/session/journal";
import { MemorySessionJournal } from "../core/session/memoryJournal";
import { SessionRecoveryCoordinator } from "../core/session/recoveryCoordinator";
import { sessionErrorText } from "../core/session/sessionErrorText";
import { SessionEventProjector } from "../core/session/sessionEventProjector";
import { SessionFrameBus, toLiveFrame } from "../core/session/sessionFrameBus";
import { SessionRuntime } from "../core/session/sessionRuntime";
import { SessionRuntimeJournal } from "../core/session/sessionRuntimeJournal";
import { SessionStepExecutor } from "../core/session/stepExecutor";
import { SessionTranscriptBridge } from "../core/session/transcriptBridge";
import { SessionTurnExecutor } from "../core/session/turnExecutor";
import { createUserMessage } from "../core/transcript/message";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStore,
} from "../core/transcript/store";
import { MemoryExecutionStore } from "../execution/memoryStore";
import type { ExecutionStore } from "../execution/store";
import type { CodingAgentInput } from "./agent";
import type { CodingBot } from "./bot";
import { createCodingStepBinding } from "./stepBinding";

const MANUAL_COMPACTION_AGENT_RUN = "manual-compaction";

export interface CodingApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  bot: CodingBot;
  /** durable session journal；缺省使用内存实现，CLI 宿主注入 SQLite 实现。 */
  sessionJournal?: SessionJournal;
  /** durable/live 帧广播口；宿主传入同一实例即可跨领域共享。 */
  sessionFrames?: SessionFrameBus;
  /** 旧 wire 投影的事件 store；3b 删除 envelope 通道时一并移除。 */
  executionStore?: ExecutionStore;
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
  private readonly projector: SessionEventProjector;
  private readonly bridge: SessionTranscriptBridge;
  private readonly sessionRuntime: SessionRuntime;
  private readonly recovery: SessionRecoveryCoordinator;
  private readonly runtimeJournal: SessionRuntimeJournal;
  private readonly onSnapshot?: CodingApplicationOptions["onSnapshot"];
  private readonly tokens = new Map<string, () => Promise<string>>();
  private closing = false;
  private workspaceRoot: string | null = null;

  constructor({
    agentRuntime,
    store,
    bot,
    sessionJournal,
    sessionFrames,
    executionStore,
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
      // 压缩可能发生在 step 中间；事实仍必须经唯一写入链进入 journal 与 transcript。
      onCompaction: (fact) => this.runtimeJournal.appendCompaction(fact),
    });
    this.contextPreparation = new ContextPreparation({
      compactor: this.contextCompactor,
      contextStateStore: store,
      contextWindow: () => this.agentRuntime.chatContextWindow(),
    });
    this.bridge = new SessionTranscriptBridge({ store });

    const events =
      executionStore ??
      (typeof agentRuntime.eventStore === "function"
        ? agentRuntime.eventStore()
        : new MemoryExecutionStore());
    this.projector = new SessionEventProjector({ store: events });
    const journal = new SessionRuntimeJournal({
      journal: sessionJournal ?? new MemorySessionJournal(),
      frames: this.sessionFrames,
      projector: this.projector,
      bridge: this.bridge,
      onDurableEvent: (id, event) => this.contextPreparation.recordRunEvent(id, event),
      onBoundary: (id) => this.pushSnapshot(id),
    });
    // 压缩器先于 journal 构造（journal 又依赖 preparation），因此观察口只在运行期解引用。
    this.runtimeJournal = journal;
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
      journal,
      runner,
      onStreamEvent: (step, event) => this.onStepStream(step, event),
    });
    const turnExecutor = new SessionTurnExecutor({
      journal,
      stepExecutor,
      createMessageId: () => randomUUID(),
    });
    this.sessionRuntime = new SessionRuntime({
      journal,
      executor: turnExecutor,
      compactor: {
        compact: (request, signal) => this.compactWithRuntime(request, signal),
      },
      createMessageId: () => randomUUID(),
    });
    this.recovery = new SessionRecoveryCoordinator({
      recoverFacts: (id) => this.sessionRuntime.recoverFacts(id),
      resumeQueued: (id, runtime) => this.sessionRuntime.resumeQueued(id, runtime),
      eventRevision: async (id) => (await this.store.load(id)).eventRevision,
      seedRevision: (id, revision) => this.projector.seed(id, revision),
      revision: (id) => this.projector.revision(id),
      journalLastSeq: (id) => this.runtimeJournal.lastSequence(id),
      seedLastSeq: (id, sequence) => this.store.advanceLastSeq(id, sequence),
      suspendUi: (id, suspended) => this.projector.suspend(id, suspended),
      restoreTranscript: (id, plan, revision) => this.bridge.recover(id, plan, revision),
      onRecovered: async (id, plan) => {
        if (plan.interruptedTurnIds.length > 0) await this.pushSnapshot(id);
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
    await this.agentRuntime.resetExecution(conversationId);
    this.tokens.delete(conversationId);
    this.recovery.forget(session);
    await this.store.clear(conversationId, {
      eventRevision: await this.projector.revision(conversationId),
    });
    await this.runtimeJournal.clear(session);
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

  /** 按 durable `seq` 读取事实帧；CLI 的 transcript 直接按帧折叠。 */
  async readFramesAfter(conversationId: string, afterSeq: number): Promise<SessionFrame[]> {
    const rows = await this.runtimeJournal.readAfter(asSessionId(conversationId), afterSeq);
    return rows.map(toSessionFrame);
  }

  /** 旧 wire 的按 revision 读取；3b 删除 envelope 通道时一并移除。 */
  readEventsAfter(conversationId: string, revision: number): Promise<AgentEventEnvelope[]> {
    return this.projector.readEvents(conversationId, revision);
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

  private async onStepStream(step: StepStart, event: AgentStreamEvent): Promise<void> {
    const live = toLiveFrame(step, event);
    if (live !== undefined) this.sessionFrames.publishLive(live);
    await this.projector.applyLive(step, event);
    await this.bridge.applyLive(step.sessionId, step.messageId, event);
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
