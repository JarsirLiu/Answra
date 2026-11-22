/**
 * Interview application：拥有演练/资料整理的文本回合与语音结算后的自动回复。
 * Turn/Step 状态由 `SessionRuntime` 持有，本文件只做领域装配、宿主端口与兼容 DTO 接线。
 */
import { randomUUID } from "node:crypto";
import type { ConversationSnapshot, InterviewProfileSeed } from "@answra/shared";
import type {
  AgentEventEnvelope,
  AgentRunSnapshot,
  AgentStreamEvent,
  SessionFrame,
} from "@answra/shared/schema";
import { toSessionFrame } from "@answra/shared/schema";
import type { AgentExecutor, AgentId } from "../core/agent/definition";
import { ProviderStepRunner } from "../core/agent/providerStepRunner";
import type { AgentRuntime } from "../core/agent/runtime";
import { ContextCompactor } from "../core/context/compaction/compactor";
import { ContextPreparation } from "../core/context/preparation";
import { PreparationStepContextManager } from "../core/context/stepContextManager";
import type { SessionId, StepRunner, StepStart } from "../core/session/contracts";
import { sessionId as asSessionId, turnId as asTurnId } from "../core/session/contracts";
import type { SessionJournal } from "../core/session/journal";
import { MemorySessionJournal } from "../core/session/memoryJournal";
import { SessionRecoveryCoordinator } from "../core/session/recoveryCoordinator";
import { SessionEventProjector } from "../core/session/sessionEventProjector";
import { SessionFrameBus, toLiveFrame } from "../core/session/sessionFrameBus";
import { SessionRuntime } from "../core/session/sessionRuntime";
import { SessionRuntimeJournal } from "../core/session/sessionRuntimeJournal";
import { SessionStepExecutor } from "../core/session/stepExecutor";
import { SessionTranscriptBridge } from "../core/session/transcriptBridge";
import { SessionTurnExecutor } from "../core/session/turnExecutor";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationStore } from "../core/transcript/store";
import { MemoryExecutionStore } from "../execution/memoryStore";
import type { ExecutionStore } from "../execution/store";
import type { CommittedInterviewTurn, InterviewAgentInput } from "./contracts";
import { InterviewReplyLoop } from "./reply/loop";
import { createInterviewStepBinding } from "./stepBinding";

export interface InterviewApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  executor: AgentExecutor<InterviewAgentInput>;
  /** 面试演练回复的 assistant 消息归属。 */
  authorAgentId: AgentId;
  requestAccessToken: () => Promise<string>;
  /** durable session journal；缺省使用内存实现，桌面宿主注入 SQLite 实现。 */
  sessionJournal?: SessionJournal;
  /** UI 事件 store；缺省复用 AgentRuntime 的事件存储。 */
  executionStore?: ExecutionStore;
  /** durable/live 帧广播口；宿主传入同一实例即可跨领域共享。 */
  sessionFrames?: SessionFrameBus;
  /** 测试注入的 StepRunner；生产由 ProviderStepRunner 提供。 */
  stepRunner?: StepRunner;
  onSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
  onTurnCommitted: (turn: CommittedInterviewTurn) => void;
  onError: (stage: "append" | "reply", error: unknown) => void;
}

export class InterviewApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly authorAgentId: AgentId;
  private readonly requestAccessToken: () => Promise<string>;
  private readonly onSnapshot: (snapshot: ConversationSnapshot) => Promise<void>;
  private readonly onError: InterviewApplicationOptions["onError"];
  private readonly contextCompactor: ContextCompactor;
  private readonly contextPreparation: ContextPreparation;
  private readonly sessionFrames: SessionFrameBus;
  private readonly projector: SessionEventProjector;
  private readonly bridge: SessionTranscriptBridge;
  private readonly sessionRuntime: SessionRuntime;
  private readonly recovery: SessionRecoveryCoordinator;
  private readonly runtimeJournal: SessionRuntimeJournal;
  private readonly replyLoop: InterviewReplyLoop;
  private workspaceRoot: string | null = null;
  private interviewDataRoot: string | null = null;
  private profileSeed: InterviewProfileSeed | null = null;

  constructor(options: InterviewApplicationOptions) {
    this.agentRuntime = options.agentRuntime;
    this.store = options.store;
    this.authorAgentId = options.authorAgentId;
    this.requestAccessToken = options.requestAccessToken;
    this.onSnapshot = options.onSnapshot;
    this.onError = options.onError;
    this.sessionFrames = options.sessionFrames ?? new SessionFrameBus();
    this.contextCompactor = new ContextCompactor({
      store: options.store,
      generate: ({ prompt, accessToken, signal }) =>
        options.agentRuntime.generateText({
          prompt,
          accessToken,
          ...(signal ? { signal } : {}),
        }),
      onSnapshot: options.onSnapshot,
      // 面试同样会在 step 前自动压缩；事实必须进入同一 journal，恢复才能收口。
      onCompaction: (fact) => this.runtimeJournal.appendCompaction(fact),
    });
    this.contextPreparation = new ContextPreparation({
      compactor: this.contextCompactor,
      contextStateStore: options.store,
      contextWindow: () => options.agentRuntime.chatContextWindow(),
    });

    const events =
      options.executionStore ??
      (typeof options.agentRuntime.eventStore === "function"
        ? options.agentRuntime.eventStore()
        : new MemoryExecutionStore());
    this.projector = new SessionEventProjector({ store: events });
    this.bridge = new SessionTranscriptBridge({ store: options.store });
    const journal = new SessionRuntimeJournal({
      journal: options.sessionJournal ?? new MemorySessionJournal(),
      frames: this.sessionFrames,
      projector: this.projector,
      bridge: this.bridge,
      onDurableEvent: (id, event) => this.contextPreparation.recordRunEvent(id, event),
      onBoundary: (id) => this.pushSnapshot(id),
    });
    // 压缩器先于 journal 构造（journal 又依赖 preparation），因此观察口只在运行期解引用。
    this.runtimeJournal = journal;
    const binding = createInterviewStepBinding({
      executor: options.executor,
      workspaceRoot: () => this.workspaceRoot,
      interviewDataRoot: () => this.interviewDataRoot,
      profileSeed: () => this.profileSeed,
    });
    const runner =
      options.stepRunner ??
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

    this.replyLoop = new InterviewReplyLoop({
      ports: {
        appendUserTurn: (conversationId, turns, text) =>
          this.appendUserTurn(conversationId, turns, text, options.onTurnCommitted),
        startReply: async (conversationId) => {
          const { turnId } = await this.startReply(conversationId);
          return { turnId };
        },
        cancelReply: (conversationId, turnId) => this.cancel(conversationId, turnId),
        waitForReply: (conversationId, turnId) => this.waitForTurn(conversationId, turnId),
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

  setProfileSeed(seed: InterviewProfileSeed | null): void {
    this.profileSeed = seed;
  }

  start(): void {
    this.replyLoop.start();
  }

  /**
   * 打开演练会话：已有消息或活动 run 时只恢复页面；
   * 空会话启动一次 opening Turn，不写假的 user 消息。
   */
  async open(conversationId: string): Promise<{ snapshot: ConversationSnapshot; turnId?: string }> {
    const snapshot = await this.createConversation(conversationId);
    if (snapshot.messages.length > 0 || snapshot.activeTurnId) return { snapshot };
    const started = await this.startReply(conversationId, "opening");
    return { snapshot: started.snapshot, turnId: started.turnId };
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
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 32_000) throw new Error("面试消息无效或过长");
    await this.ensureRecovered(conversationId);
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

  /** 退出屏障：先停回复循环，再等待所有演练 Turn 的终态落账。 */
  async shutdown(): Promise<void> {
    await this.replyLoop.stop();
    await this.sessionRuntime.shutdown();
  }

  getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.loadRecoveredSnapshot(conversationId);
  }

  async createConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.create(conversationId, undefined, {
      scope: "interview",
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
    });
    return this.loadRecoveredSnapshot(conversationId);
  }

  cancel(conversationId: string, turnId: string): void {
    void this.sessionRuntime
      .cancel(asSessionId(conversationId), asTurnId(turnId))
      .catch((error: unknown) => {
        this.onError("reply", error);
      });
  }

  waitForTurn(conversationId: string, turnId: string): Promise<void> {
    return this.sessionRuntime
      .waitForTurn(asSessionId(conversationId), asTurnId(turnId))
      .then(() => undefined);
  }

  getExecutionRun(runId: string): Promise<AgentRunSnapshot | undefined> {
    return this.agentRuntime.getRun(runId);
  }

  readExecutionEvents(runId: string): Promise<AgentEventEnvelope[]> {
    return this.agentRuntime.readEventsForRun(runId);
  }

  readEvents(conversationId: string, afterRevision: number): Promise<AgentEventEnvelope[]> {
    return this.projector.readEvents(conversationId, afterRevision);
  }

  /** 按 durable `seq` 读取事实帧；面试演练的 UI 与文本会话共用。 */
  async readFrames(conversationId: string, afterSeq: number): Promise<SessionFrame[]> {
    const rows = await this.runtimeJournal.readAfter(asSessionId(conversationId), afterSeq);
    return rows.map(toSessionFrame);
  }

  /** 立即中止活动 Turn；宿主硬退出时使用，正常退出走 `shutdown`。 */
  dispose(): void {
    this.sessionRuntime.dispose();
  }

  private async loadRecoveredSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    await this.ensureRecovered(conversationId);
    return this.loadRecoverySnapshot(conversationId);
  }

  /**
   * 启动恢复只允许在 scheduler 创建前执行；顺序与并发去重由
   * `SessionRecoveryCoordinator` 统一持有，领域不复制恢复流程。
   */
  private async ensureRecovered(conversationId: string): Promise<SessionId> {
    const id = asSessionId(conversationId);
    await this.recovery.ensure(id, { getAccessToken: this.requestAccessToken });
    return id;
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
    source: "opening" | "reply" = "reply",
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    // 端点未配置时在入队前失败：已写入的 user 消息保留，不产生空的 assistant 占位。
    if (typeof this.agentRuntime.chatEndpoint === "function") this.agentRuntime.chatEndpoint();
    const session = await this.ensureRecovered(conversationId);
    const submission = await this.sessionRuntime.submit({
      sessionId: session,
      source,
      agentId: this.authorAgentId,
      runtime: { getAccessToken: this.requestAccessToken },
    });
    return {
      turnId: submission.turnId,
      snapshot: await this.loadRecoverySnapshot(conversationId),
    };
  }

  private async loadRecoverySnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.store.load(conversationId);
  }

  private async pushSnapshot(conversationId: string): Promise<void> {
    await this.onSnapshot(await this.loadRecoverySnapshot(conversationId));
  }

  private async onStepStream(step: StepStart, event: AgentStreamEvent): Promise<void> {
    const live = toLiveFrame(step, event);
    if (live !== undefined) this.sessionFrames.publishLive(live);
    await this.projector.applyLive(step, event);
    await this.bridge.applyLive(step.sessionId, step.messageId, event);
  }
}
