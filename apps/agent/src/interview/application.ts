/**
 * Interview application：拥有演练/资料整理的文本回合与语音结算后的自动回复。
 * Turn/Step 状态由 `SessionRuntime` 持有，本文件只做领域装配、宿主端口与兼容 DTO 接线。
 */
import { randomUUID } from "node:crypto";
import type { ConversationSnapshot, InterviewProfileSeed } from "@answra/shared";
import type { SessionFrame } from "@answra/shared/schema";
import type { AgentExecutor, AgentId } from "../core/agent/definition";
import { ProviderStepRunner } from "../core/agent/providerStepRunner";
import type { AgentRuntime } from "../core/agent/runtime";
import { ContextCompactor } from "../core/context/compaction/compactor";
import { ContextPreparation } from "../core/context/preparation";
import { PreparationStepContextManager } from "../core/context/stepContextManager";
import type { SessionId, StepRunner } from "../core/session/contracts";
import { sessionId as asSessionId, turnId as asTurnId } from "../core/session/contracts";
import { SessionItemRecorder } from "../core/session/itemRecorder";
import { SessionRecoveryCoordinator } from "../core/session/recoveryCoordinator";
import { SessionFrameBus } from "../core/session/sessionFrameBus";
import { SessionRuntime } from "../core/session/sessionRuntime";
import { SessionStepExecutor } from "../core/session/stepExecutor";
import { SessionTurnExecutor } from "../core/session/turnExecutor";
import type { SessionItemStore } from "../core/transcript/itemStore";
import { MemorySessionItemStore } from "../core/transcript/memoryItemStore";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationStore } from "../core/transcript/store";
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
  /** durable 会话条目；缺省使用内存实现，桌面宿主注入 SQLite 实现。 */
  sessionItems?: SessionItemStore;
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
  private readonly sessionRuntime: SessionRuntime;
  private readonly recovery: SessionRecoveryCoordinator;
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
    });
    this.contextPreparation = new ContextPreparation({
      compactor: this.contextCompactor,
      contextStateStore: options.store,
      contextWindow: () => options.agentRuntime.chatContextWindow(),
    });

    const items = options.sessionItems ?? new MemorySessionItemStore();
    const recorder = new SessionItemRecorder({
      items,
      store: options.store,
      frames: this.sessionFrames,
      onSnapshot: (id) => this.pushSnapshot(id),
      onTurnFinished: (id, outcome) => this.contextPreparation.recordTurnFinished(id, outcome),
    });
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
      store: options.store,
      recorder,
      executor: turnExecutor,
      // 面试只有一位面试官 Bot；转写与开场都由它回复。
      defaults: { agentId: options.authorAgentId, source: "reply" },
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
    const session = await this.ensureRecovered(conversationId);
    const appended = await this.sessionRuntime.appendUserMessage(
      session,
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
    await this.sessionRuntime.createSession(asSessionId(conversationId));
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

  /** 按 durable `seq` 读取条目帧；面试演练的 UI 与文本会话共用。 */
  async readFrames(conversationId: string, afterSeq: number): Promise<SessionFrame[]> {
    return this.sessionRuntime.readFramesAfter(asSessionId(conversationId), afterSeq);
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
    const session = await this.ensureRecovered(conversationId);
    const snapshot = await this.sessionRuntime.appendUserMessage(
      session,
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
}
