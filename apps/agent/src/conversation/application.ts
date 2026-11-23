/**
 * Conversation application：唯一会话编排循环。Session 底座拥有 Turn/Step 状态与恢复，
 * transcript 继续负责历史展示；本文件只做领域装配、宿主端口与兼容 DTO 的接线。
 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSelection,
  ConversationSendRequest,
  ConversationSendResult,
  ConversationSnapshot,
  ManualCompactionResult,
} from "@answra/shared";
import type { SessionFrame, TurnOutcome } from "@answra/shared/schema";
import type { ConversationAgentInput } from "../bots/general/agent";
import { type AgentId, agentId } from "../core/agent/definition";
import { ProviderStepRunner } from "../core/agent/providerStepRunner";
import type { AgentRuntime } from "../core/agent/runtime";
import type { BotSummary } from "../core/bot/contracts";
import { assertBotDiscoveryReferences, assertCanHandoff } from "../core/bot/directory";
import { ContextCompactor } from "../core/context/compaction/compactor";
import { ContextPreparation } from "../core/context/preparation";
import { PreparationStepContextManager } from "../core/context/stepContextManager";
import { validateModelRequest } from "../core/model/requestContent";
import type {
  SessionCompactionRequest,
  SessionId,
  StepRunner,
  TurnId,
} from "../core/session/contracts";
import { sessionId as asSessionId, turnId as asTurnId } from "../core/session/contracts";
import { SessionItemRecorder } from "../core/session/itemRecorder";
import { SessionRecoveryCoordinator } from "../core/session/recoveryCoordinator";
import { sessionErrorText } from "../core/session/sessionErrorText";
import { SessionFrameBus } from "../core/session/sessionFrameBus";
import { SessionRuntime } from "../core/session/sessionRuntime";
import { SessionStepExecutor } from "../core/session/stepExecutor";
import { SessionTurnExecutor } from "../core/session/turnExecutor";
import {
  assertTeamPreset,
  createTeamPresetCatalog,
  type TeamPreset,
  type TeamPresetCatalog,
} from "../core/team/preset";
import type { SessionItemStore } from "../core/transcript/itemStore";
import { MemorySessionItemStore } from "../core/transcript/memoryItemStore";
import { createUserMessage } from "../core/transcript/message";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStore,
} from "../core/transcript/store";
import { CONVERSATION_AGENT_ID, CONVERSATION_TEAM_ID } from "./agent";
import type { ConversationBot, ConversationBotCatalog } from "./bots/types";
import { CHAT_PROFILES, type ChatProfileId } from "./profiles/registry";
import { createConversationStepBinding } from "./stepBinding";

const MAX_USER_MESSAGE_CHARS = 32_000;

export interface ConversationApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  /** 已装配的 Conversation Bot 目录；Bot 身份与发现的唯一来源。 */
  catalog: ConversationBotCatalog;
  /** 团队预置；缺省时把 conversation 入口 Bot 作为单成员团队。 */
  presets?: readonly TeamPreset[];
  /** durable 会话条目；缺省使用内存实现，桌面宿主注入 SQLite 实现。 */
  sessionItems?: SessionItemStore;
  /** durable/live 帧广播口；宿主传入同一实例即可跨领域共享。 */
  sessionFrames?: SessionFrameBus;
  /** 测试注入的 StepRunner；生产由 ProviderStepRunner 提供。 */
  stepRunner?: StepRunner;
  /** 每段 run 启动与交接写入后的权威 snapshot 推送。 */
  onSnapshot?: (snapshot: ConversationSnapshot) => void | Promise<void>;
  /** 后台交接链失败；不静默吞掉，也不伪造第二条 AI 消息。 */
  onTeamError?: (error: unknown) => void;
}

export class ConversationApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly catalog: ConversationBotCatalog;
  private readonly presets: TeamPresetCatalog;
  private readonly defaultBotId: AgentId;
  private readonly contextCompactor: ContextCompactor;
  private readonly contextPreparation: ContextPreparation;
  private readonly sessionFrames: SessionFrameBus;
  private readonly sessionRuntime: SessionRuntime;
  private readonly recovery: SessionRecoveryCoordinator;
  private readonly onSnapshot?: ConversationApplicationOptions["onSnapshot"];
  private readonly onTeamError?: ConversationApplicationOptions["onTeamError"];
  private readonly tokens = new Map<string, () => Promise<string>>();
  private closing = false;
  private workspaceRoot: string | null = null;

  constructor({
    agentRuntime,
    store,
    catalog,
    presets = [],
    sessionItems,
    sessionFrames,
    stepRunner,
    onSnapshot,
    onTeamError,
  }: ConversationApplicationOptions) {
    this.agentRuntime = agentRuntime;
    this.store = store;
    this.onSnapshot = onSnapshot;
    this.onTeamError = onTeamError;
    this.sessionFrames = sessionFrames ?? new SessionFrameBus();
    this.catalog = catalog;
    const presetInput = withConversationPreset(presets, this.catalog);
    this.presets = createTeamPresetCatalog(presetInput);
    for (const preset of this.presets.list()) {
      assertTeamPreset(preset, this.catalog, this.presets.teams());
      this.agentRuntime.assertTeamMembers(preset.entryBotId, preset.memberBotIds);
    }
    assertBotDiscoveryReferences({ catalog: this.catalog, teams: this.presets.teams() });
    this.agentRuntime.assertRegistered(this.catalog.ids());
    const defaultBotId =
      this.presets.find(CONVERSATION_TEAM_ID)?.entryBotId ?? this.catalog.ids()[0];
    if (!defaultBotId) throw new Error("Conversation Bot 目录为空");
    this.defaultBotId = defaultBotId;
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
      authorizeHandoff: async (id, handoff) => {
        const snapshot = await this.loadRecoverySnapshot(id);
        assertCanHandoff({
          participants: snapshot.participantAgentIds ?? this.catalog.ids(),
          from: agentId(handoff.fromAgentId),
          to: agentId(handoff.toAgentId),
          catalog: this.catalog,
          teams: this.presets.teams(),
        });
      },
    });
    const binding = createConversationStepBinding({
      catalog,
      workspaceRoot: () => this.workspaceRoot,
    });
    const runner =
      stepRunner ??
      new ProviderStepRunner({
        getEndpoint: () => this.agentRuntime.chatEndpoint(),
        prepare: binding.prepare,
        contextManager: new PreparationStepContextManager(this.contextPreparation),
        resolveHandoff: binding.resolveHandoff,
        tokenProvider: this.agentRuntime.modelTokenProvider?.(),
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
      defaults: { agentId: this.defaultBotId, source: "user" },
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
      scope: "conversation",
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
    };
  }

  private tokenProvider(conversationId: string): () => Promise<string> {
    return this.tokens.get(conversationId) ?? (() => Promise.reject(new Error("会话缺少访问令牌")));
  }

  /**
   * 启动恢复只允许在 scheduler 创建前执行：先对齐 UI revision，再收口中断 Turn。
   * 顺序与并发去重由 `SessionRecoveryCoordinator` 统一持有。
   */
  private async ensureRecovered(conversationId: string): Promise<SessionId> {
    const id = asSessionId(conversationId);
    await this.recovery.ensure(id, { getAccessToken: this.tokenProvider(conversationId) });
    return id;
  }

  listBots(): readonly BotSummary[] {
    return this.catalog.list();
  }

  async getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    // Interview/Answer 等其他产品面共用 transcript 与事件游标；恢复必须由所属领域执行。
    // 旧会话可能没有 metadata.scope，按 conversation 处理，避免跳过既有恢复。
    const scope = await this.store.scopeOf(conversationId);
    if (scope === undefined || scope === "conversation") await this.ensureRecovered(conversationId);
    return this.loadRecoverySnapshot(conversationId);
  }

  private async loadRecoverySnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.store.load(conversationId);
  }

  /** 按 durable `seq` 读取条目帧；客户端按 `seq` 幂等折叠并补齐缺口。 */
  async readFramesAfter(conversationId: string, afterSeq: number): Promise<SessionFrame[]> {
    return this.sessionRuntime.readFramesAfter(asSessionId(conversationId), afterSeq);
  }

  async createConversation(
    conversationId: string,
    selection?: ConversationSelection,
  ): Promise<ConversationSnapshot> {
    const seed = this.resolveSelection(selection);
    const snapshot = await this.store.create(conversationId, seed, this.sessionMetadata());
    await this.sessionRuntime.createSession(asSessionId(conversationId));
    if (
      selection &&
      snapshot.participantAgentIds &&
      !sameParticipants(snapshot.participantAgentIds, seed.participantAgentIds)
    ) {
      throw new Error("会话已存在且 Bot 参与者不同");
    }
    await this.ensureRecovered(conversationId);
    return this.loadRecoverySnapshot(conversationId);
  }

  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    const session = await this.ensureRecovered(conversationId);
    await this.sessionRuntime.cancelSession(session);
    this.tokens.delete(conversationId);
    this.recovery.forget(session);
    await this.store.clear(conversationId);
    await this.sessionRuntime.clear(session);
    return this.loadRecoverySnapshot(conversationId);
  }

  async compactConversation(
    conversationId: string,
    accessToken: string,
    { signal, instructions }: { signal?: AbortSignal; instructions?: string } = {},
  ): Promise<{ result: ManualCompactionResult; snapshot: ConversationSnapshot }> {
    const session = await this.ensureRecovered(conversationId);
    if (await this.hasQueuedMessages(conversationId)) throw new Error("仍有排队消息");
    const snapshot = await this.loadRecoverySnapshot(conversationId);
    const bot = this.requireBot(snapshot.activeAgentId ?? this.defaultBotId);
    if (!bot.policy.includeHistory) throw new Error("当前 Bot 不保留历史，无法压缩");
    this.tokens.set(conversationId, async () => accessToken);
    const result = await this.sessionRuntime.compact(session, {
      ...(instructions === undefined ? {} : { instructions }),
    });
    if (signal?.aborted) throw new Error("压缩已取消");
    return { result, snapshot: await this.loadRecoverySnapshot(conversationId) };
  }

  async appendUserMessage(conversationId: string, text: string): Promise<ConversationSnapshot> {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_USER_MESSAGE_CHARS)
      throw new Error("消息内容无效或过长");
    const session = await this.ensureRecovered(conversationId);
    return this.sessionRuntime.appendUserMessage(
      session,
      createUserMessage(randomUUID(), { text: text.trim(), images: [] }),
    );
  }

  configure(config: ConversationModelConfig): void {
    this.agentRuntime.configureModelRoutes({ chat: config.chat, answer: config.answer });
  }

  private async submitTurn({
    botId,
    conversationId,
    request,
    accessToken,
    teamId,
  }: {
    botId?: string;
    conversationId: string;
    request: ConversationSendRequest;
    accessToken: string;
    teamId?: string;
  }): Promise<{
    session: SessionId;
    turnId: TurnId;
    messageId: string;
    seed: ConversationSessionSeed;
    requested?: ConversationBot;
  }> {
    validateModelRequest(request);
    // 配置门禁必须在入队前完成：否则命令已返回成功，失败只发生在后台。
    if (this.agentRuntime.chatEndpoint !== undefined) this.agentRuntime.chatEndpoint();
    if (this.closing) throw new Error("会话正在关闭");
    const requested = botId ? this.requireBot(botId) : undefined;
    const preset = teamId === undefined ? undefined : this.presets.require(teamId);
    const seed = this.seedForBot((requested ?? this.requireBot(this.defaultBotId)).id);
    const teamSeed = preset === undefined ? seed : this.seedForTeam(preset);
    await this.store.create(conversationId, teamSeed, this.sessionMetadata());
    await this.sessionRuntime.createSession(asSessionId(conversationId));
    const session = await this.ensureRecovered(conversationId);
    const snapshot = await this.loadRecoverySnapshot(conversationId);
    if (
      preset !== undefined &&
      snapshot.participantAgentIds &&
      !sameParticipants(snapshot.participantAgentIds, teamSeed.participantAgentIds)
    ) {
      throw new Error("会话已存在且 Bot 参与者不同");
    }
    const activeAgentId = snapshot.activeAgentId ?? teamSeed.activeAgentId;
    if (requested && requested.id !== activeAgentId) {
      throw new Error(`会话当前由 ${activeAgentId} 接待，不能直接切换到 ${requested.id}`);
    }
    const entry = this.requireBot(activeAgentId);
    if (snapshot.participantAgentIds?.includes(entry.id) === false)
      throw new Error(`Bot 不属于当前会话参与者：${entry.id}`);
    this.tokens.set(conversationId, async () => accessToken);
    const submission = await this.sessionRuntime.submit({
      sessionId: session,
      source: "user",
      agentId: entry.id,
      input: createUserMessage(randomUUID(), request),
      runtime: { getAccessToken: async () => accessToken },
    });
    return {
      session,
      turnId: submission.turnId,
      messageId: submission.messageId,
      seed: teamSeed,
      ...(requested ? { requested } : {}),
    };
  }

  /** 发送一条用户消息；botId 缺省时沿用会话 activeAgentId，显式 Bot 必须与当前接待者一致。 */
  async enqueue(
    botId: string | undefined,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<ConversationSendResult> {
    const accepted = await this.submitTurn({ botId, conversationId, request, accessToken });
    const position = this.sessionRuntime.cachedPosition(accepted.session, accepted.turnId);
    if (position !== 0 && position !== undefined) {
      return {
        queueId: accepted.turnId,
        status: "queued",
        position,
      };
    }
    return {
      queueId: accepted.turnId,
      status: "started",
      position: 0,
      turnId: accepted.turnId,
      snapshot: await this.loadRecoverySnapshot(conversationId),
    };
  }

  async send(
    botId: string | undefined,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    const accepted = await this.enqueue(botId, conversationId, request, accessToken);
    if (accepted.status === "started") {
      return { turnId: accepted.turnId, snapshot: accepted.snapshot };
    }
    return {
      turnId: accepted.queueId,
      snapshot: await this.loadRecoverySnapshot(conversationId),
    };
  }

  /** `chat-send` 的迁移入口：profile 仅用于校验，Bot 由目录或会话决定。 */
  async sendChat(
    profileId: ChatProfileId,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    if (!CHAT_PROFILES[profileId]) throw new Error("未授权的对话能力配置");
    return this.send(undefined, conversationId, request, accessToken);
  }

  async enqueueTeamMessage(
    teamId: string,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<ConversationSendResult> {
    const accepted = await this.submitTurn({
      conversationId,
      request,
      accessToken,
      teamId,
    });
    const position = this.sessionRuntime.cachedPosition(accepted.session, accepted.turnId);
    if (position !== 0 && position !== undefined) {
      return { queueId: accepted.turnId, status: "queued", position };
    }
    return {
      queueId: accepted.turnId,
      status: "started",
      position: 0,
      turnId: accepted.turnId,
      snapshot: await this.loadRecoverySnapshot(conversationId),
    };
  }

  async sendTeamMessage(
    teamId: string,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    const accepted = await this.enqueueTeamMessage(teamId, conversationId, request, accessToken);
    const session = await this.ensureRecovered(conversationId);
    const turn = asTurnId(accepted.queueId);
    const completion = await this.sessionRuntime.waitForTurn(session, turn);
    if (completion.outcome === "failed") {
      const error = new Error(completion.errorText ?? "团队回合执行失败");
      this.onTeamError?.(error);
      throw error;
    }
    return {
      turnId: accepted.queueId,
      snapshot: await this.loadRecoverySnapshot(conversationId),
    };
  }

  private async compactWithRuntime(
    request: SessionCompactionRequest,
    signal: AbortSignal,
  ): Promise<ManualCompactionResult> {
    const conversationId = request.sessionId;
    const snapshot = await this.loadRecoverySnapshot(conversationId);
    const bot = this.requireBot(snapshot.activeAgentId ?? this.defaultBotId);
    if (!bot.policy.includeHistory)
      return { status: "failed", errorText: "当前 Bot 不保留历史，无法压缩" };
    const input = this.manualCompactionInput(conversationId, bot);
    const prepare = () => bot.executor.prepare(input, signal);
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

  private manualCompactionInput(
    conversationId: string,
    bot: ConversationBot,
  ): ConversationAgentInput {
    return {
      conversationId,
      runId: MANUAL_COMPACTION_AGENT_RUN,
      request: { text: "", images: [] },
      profile: bot.policy,
      workspaceRoot: this.workspaceRoot,
      viewerAgentId: bot.id,
      agentNames: new Map(this.catalog.list().map((member) => [member.id, member.name])),
    };
  }

  private async hasQueuedMessages(conversationId: string): Promise<boolean> {
    return (await this.sessionRuntime.queuedCount(asSessionId(conversationId))) > 0;
  }

  private requireBot(agentId: string): ConversationBot {
    return this.catalog.require(agentId);
  }

  private resolveSelection(selection?: ConversationSelection): ConversationSessionSeed {
    if (!selection) return this.seedForBot(this.defaultBotId);
    if (selection.kind === "bot") return this.seedForBot(selection.botId);
    return this.seedForTeam(this.presets.require(selection.teamId));
  }

  private seedForBot(botId: string): ConversationSessionSeed {
    const bot = this.requireBot(botId);
    return {
      activeAgentId: bot.id,
      participantAgentIds: [bot.id],
      bots: [{ id: bot.id, name: bot.identity.name, role: bot.identity.role }],
    };
  }

  private seedForTeam(preset: TeamPreset): ConversationSessionSeed {
    return {
      activeAgentId: preset.entryBotId,
      participantAgentIds: preset.memberBotIds,
      bots: preset.memberBotIds.map((id) => {
        const bot = this.requireBot(id);
        return { id: bot.id, name: bot.identity.name, role: bot.identity.role };
      }),
    };
  }

  private async pushSnapshot(conversationId: string): Promise<void> {
    await this.pushSnapshotValue(await this.loadRecoverySnapshot(conversationId));
  }

  private async pushSnapshotValue(snapshot: ConversationSnapshot): Promise<void> {
    if (!this.onSnapshot) return;
    await this.onSnapshot(snapshot);
  }

  /** 取消指定 Turn；queued Turn 保持原语义由 SessionRuntime 决定。 */
  cancel(conversationId: string, turnId: string): void {
    void this.sessionRuntime
      .cancel(asSessionId(conversationId), asTurnId(turnId))
      .catch((error: unknown) => {
        this.onTeamError?.(error);
      });
  }

  waitForQueue(
    conversationId: string,
    queueId: string,
  ): Promise<{
    queueId: string;
    turnId?: string;
    outcome: TurnOutcome;
  }> {
    const session = asSessionId(conversationId);
    return this.sessionRuntime.waitForTurn(session, asTurnId(queueId)).then((completion) => ({
      queueId,
      turnId: queueId,
      outcome: completion.outcome,
    }));
  }

  waitForQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<{
    queueId: string;
    turnId: string;
    snapshot: ConversationSnapshot;
  }> {
    const session = asSessionId(conversationId);
    return this.sessionRuntime.waitForTurnStart(session, asTurnId(queueId)).then(async () => ({
      queueId,
      turnId: queueId,
      snapshot: await this.loadRecoverySnapshot(conversationId),
    }));
  }

  getQueuePosition(conversationId: string, queueId: string): number | undefined {
    // 同步契约由内存 projection 提供；异步 scheduler 尚未创建时直接返回 undefined。
    const pending = this.sessionRuntime.position(asSessionId(conversationId), asTurnId(queueId));
    void pending;
    return this.sessionRuntime.cachedPosition(asSessionId(conversationId), asTurnId(queueId));
  }

  /** 等待指定 Turn 结束；调用方按 Turn 而不是消息定位。 */
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

  /** 退出屏障：阻止新 Turn 后等待活动/排队 Turn 的终态落盘，供 store 关闭前调用。 */
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.sessionRuntime.shutdown();
  }

  dispose(): void {
    this.closing = true;
    this.sessionRuntime.dispose();
    this.agentRuntime.dispose();
  }
}

const MANUAL_COMPACTION_AGENT_RUN = "manual-compaction";

function withConversationPreset(
  presets: readonly TeamPreset[],
  catalog: ConversationBotCatalog,
): readonly TeamPreset[] {
  const general = catalog.find(CONVERSATION_AGENT_ID);
  if (!general || presets.some((preset) => preset.teamId === CONVERSATION_TEAM_ID)) return presets;
  return [
    ...presets,
    {
      teamId: CONVERSATION_TEAM_ID,
      entryBotId: general.id,
      memberBotIds: [general.id],
    },
  ];
}

function sameParticipants(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const ids = new Set(left);
  return right.every((id) => ids.has(id));
}
