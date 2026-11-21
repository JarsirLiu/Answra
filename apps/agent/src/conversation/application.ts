/** Conversation application：唯一会话编排循环、transcript 认领与注册 Agent 的执行接线。 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSelection,
  ConversationSendRequest,
  ConversationSendResult,
  ConversationSnapshot,
  ManualCompactionResult,
} from "@answra/shared";
import type { AgentEventEnvelope, AgentRunSnapshot } from "@answra/shared/schema";
import type { AgentId, AgentRunHandle } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import type { BotSummary } from "../core/bot/contracts";
import { assertBotDiscoveryReferences, assertCanHandoff } from "../core/bot/directory";
import { ContextCompactor } from "../core/context/compaction/compactor";
import { ContextPreparation } from "../core/context/preparation";
import { validateModelRequest } from "../core/model/requestContent";
import type { TurnQueueOutcome } from "../core/queue/turnQueue";
import { TurnQueueRegistry } from "../core/queue/turnQueueRegistry";
import { assertHandoffTask } from "../core/team/handoff";
import {
  assertTeamPreset,
  createTeamPresetCatalog,
  type TeamPreset,
  type TeamPresetCatalog,
} from "../core/team/preset";
import { createUserMessage } from "../core/transcript/message";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStore,
} from "../core/transcript/store";
import { CONVERSATION_AGENT_ID, CONVERSATION_TEAM_ID, type ConversationAgentInput } from "./agent";
import type { ConversationBot, ConversationBotCatalog } from "./bots/types";
import { CHAT_PROFILES, type ChatProfileId } from "./profiles/registry";

const MAX_USER_MESSAGE_CHARS = 32_000;
const MANUAL_COMPACTION_AGENT_RUN = "manual-compaction";

export interface ConversationApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  /** 已装配的 Conversation Bot 目录；Bot 身份与发现的唯一来源。 */
  catalog: ConversationBotCatalog;
  /** 团队预置；缺省时把 conversation 入口 Bot 作为单成员团队。 */
  presets?: readonly TeamPreset[];
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
  private readonly onSnapshot?: ConversationApplicationOptions["onSnapshot"];
  private readonly onTeamError?: ConversationApplicationOptions["onTeamError"];
  private readonly turns = new TurnQueueRegistry();
  private closing = false;
  private workspaceRoot: string | null = null;

  constructor({
    agentRuntime,
    store,
    catalog,
    presets = [],
    onSnapshot,
    onTeamError,
  }: ConversationApplicationOptions) {
    this.agentRuntime = agentRuntime;
    this.store = store;
    this.onSnapshot = onSnapshot;
    this.onTeamError = onTeamError;
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

  listBots(): readonly BotSummary[] {
    return this.catalog.list();
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

  /** 新建会话；selection 缺省使用 conversation 入口 Bot。已存在会话不接受不同参与者。 */
  async createConversation(
    conversationId: string,
    selection?: ConversationSelection,
  ): Promise<ConversationSnapshot> {
    const seed = this.resolveSelection(selection);
    const snapshot = await this.store.create(conversationId, seed, this.sessionMetadata());
    if (
      selection &&
      snapshot.participantAgentIds &&
      !sameParticipants(snapshot.participantAgentIds, seed.participantAgentIds)
    ) {
      throw new Error("会话已存在且 Bot 参与者不同");
    }
    return this.loadRecoverySnapshot(conversationId);
  }

  /** 用户显式清空会话；仓储只允许清空空闲会话，并返回清空后的 snapshot。 */
  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    this.turns.cancelPending(conversationId);
    const eventRevision = await this.agentRuntime.getConversationRevision(conversationId);
    await this.store.clear(conversationId, eventRevision);
    return this.loadRecoverySnapshot(conversationId);
  }

  /** 手动压缩当前会话；不追加用户消息，也不创建 Agent run。 */
  async compactConversation(
    conversationId: string,
    accessToken: string,
    { signal, instructions }: { signal?: AbortSignal; instructions?: string } = {},
  ): Promise<{ result: ManualCompactionResult; snapshot: ConversationSnapshot }> {
    if (this.agentRuntime.activeRunCount > 0) throw new Error("上一轮尚未结束");
    if (this.hasQueuedMessages(conversationId)) throw new Error("仍有排队消息");
    const snapshot = await this.loadRecoverySnapshot(conversationId);
    const bot = this.requireBot(snapshot.activeAgentId ?? this.defaultBotId);
    if (!bot.policy.includeHistory) throw new Error("当前 Bot 不保留历史，无法压缩");
    const controller = new AbortController();
    const abortSignal = signal ?? controller.signal;
    const input = this.manualCompactionInput(conversationId, bot);
    const modelRequest = await bot.executor.prepare(input, abortSignal);
    const result = await this.contextPreparation.compactNow({
      conversationId,
      getAccessToken: async () => accessToken,
      modelRequest,
      rebuild: () => bot.executor.prepare(input, abortSignal),
      signal: abortSignal,
      ...(instructions === undefined ? {} : { compactionInstructions: instructions }),
      onStatus: () => this.pushSnapshot(conversationId),
    });
    return { result, snapshot: await this.loadRecoverySnapshot(conversationId) };
  }

  async appendUserMessage(conversationId: string, text: string): Promise<ConversationSnapshot> {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_USER_MESSAGE_CHARS)
      throw new Error("消息内容无效或过长");
    return this.store.appendUserMessage(
      conversationId,
      createUserMessage(randomUUID(), { text: text.trim(), images: [] }),
    );
  }

  configure(config: ConversationModelConfig): void {
    this.agentRuntime.configureModelRoutes({ chat: config.chat, answer: config.answer });
  }

  /** 发送一条用户消息；botId 缺省时沿用会话 activeAgentId，显式 Bot 必须与当前接待者一致。 */
  async enqueue(
    botId: string | undefined,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<ConversationSendResult> {
    validateModelRequest(request);
    const requested = botId ? this.requireBot(botId) : undefined;
    const seed = this.seedForBot((requested ?? this.requireBot(this.defaultBotId)).id);
    await this.store.create(conversationId, seed, this.sessionMetadata());
    const getAccessToken = async () => accessToken;
    return this.turns.enqueue(conversationId, async () => {
      const snapshot = await this.loadRecoverySnapshot(conversationId);
      const activeAgentId = snapshot.activeAgentId ?? seed.activeAgentId;
      if (requested && requested.id !== activeAgentId) {
        throw new Error(`会话当前由 ${activeAgentId} 接待，不能直接切换到 ${requested.id}`);
      }
      const entry = this.requireBot(activeAgentId);
      const handle = await this.startBot({
        conversationId,
        bot: entry,
        trigger: { kind: "user", request },
        getAccessToken,
      });
      this.turns.trackRun(conversationId, handle.runId);
      const completion = this.continueTeamTurn({
        conversationId,
        from: entry,
        handle,
        getAccessToken,
      })
        .catch((error: unknown) => {
          this.onTeamError?.(error);
          throw error;
        })
        .finally(() => this.turns.untrackRun(handle.runId));
      return { runId: handle.runId, snapshot: handle.prepared, completion };
    });
  }

  async send(
    botId: string | undefined,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const accepted = await this.enqueue(botId, conversationId, request, accessToken);
    if (accepted.status === "started") {
      return { runId: accepted.runId, snapshot: accepted.snapshot };
    }
    const started = await this.turns.waitForStart(conversationId, accepted.queueId);
    return { runId: started.runId, snapshot: started.snapshot };
  }

  /** `chat-send` 的迁移入口：profile 仅用于校验，Bot 由目录或会话决定。 */
  async sendChat(
    profileId: ChatProfileId,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    if (!CHAT_PROFILES[profileId]) throw new Error("未授权的对话能力配置");
    return this.send(undefined, conversationId, request, accessToken);
  }

  /** `team-send`：显式团队入口；等待整条交接链回到 idle 后返回最终 snapshot。 */
  async enqueueTeamMessage(
    teamId: string,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<ConversationSendResult> {
    validateModelRequest(request);
    const preset = this.presets.require(teamId);
    const seed = this.seedForTeam(preset);
    await this.store.create(conversationId, seed, this.sessionMetadata());
    const getAccessToken = async () => accessToken;
    return this.turns.enqueue(conversationId, async () => {
      const snapshot = await this.loadRecoverySnapshot(conversationId);
      if (
        snapshot.participantAgentIds &&
        !sameParticipants(snapshot.participantAgentIds, seed.participantAgentIds)
      ) {
        throw new Error("会话已存在且 Bot 参与者不同");
      }
      const entry = this.requireBot(snapshot.activeAgentId ?? preset.entryBotId);
      const participants = snapshot.participantAgentIds ?? preset.memberBotIds;
      if (!participants.includes(entry.id))
        throw new Error(`Bot 不属于当前会话参与者：${entry.id}`);
      const first = await this.startBot({
        conversationId,
        bot: entry,
        trigger: { kind: "user", request },
        getAccessToken,
      });
      this.turns.trackRun(conversationId, first.runId);
      const completion = this.continueTeamTurn({
        conversationId,
        from: entry,
        handle: first,
        getAccessToken,
      })
        .catch((error: unknown) => {
          this.onTeamError?.(error);
          throw error;
        })
        .finally(() => this.turns.untrackRun(first.runId));
      return { runId: first.runId, snapshot: first.prepared, completion };
    });
  }

  async sendTeamMessage(
    teamId: string,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const accepted = await this.enqueueTeamMessage(teamId, conversationId, request, accessToken);
    const completion = await this.turns.wait(conversationId, accepted.queueId);
    if (completion.failure !== undefined) throw completion.failure.error;
    const snapshot = await this.loadRecoverySnapshot(conversationId);
    if (!completion.runId) throw new Error("团队回合未启动");
    return { runId: completion.runId, snapshot };
  }

  private async continueTeamTurn({
    conversationId,
    from,
    handle,
    getAccessToken,
  }: {
    conversationId: string;
    from: ConversationBot;
    handle: AgentRunHandle<ConversationSnapshot>;
    getAccessToken: () => Promise<string>;
  }): Promise<TurnQueueOutcome> {
    const queueId = this.turns.activeQueueId(conversationId);
    let current = from;
    let currentHandle = handle;
    for (;;) {
      const outcome = await currentHandle.done;
      if (outcome !== "completed") return toQueueOutcome(outcome);
      if (this.hasQueuedAhead(conversationId, queueId)) return "completed";
      const result = await currentHandle.result;
      if (!result) return "completed";
      assertHandoffTask(result.task);
      const snapshot = await this.loadRecoverySnapshot(conversationId);
      assertCanHandoff({
        participants: snapshot.participantAgentIds ?? [current.id],
        from: current.id,
        to: result.to,
        catalog: this.catalog,
        teams: this.presets.teams(),
      });
      await this.store.appendHandoffMessage(conversationId, {
        id: randomUUID(),
        fromAgentId: current.id,
        toAgentId: result.to,
        task: result.task,
      });
      await this.pushSnapshot(conversationId);
      const next = this.requireBot(result.to);
      currentHandle = await this.startBot({
        conversationId,
        bot: next,
        trigger: { kind: "handoff" },
        getAccessToken,
      });
      current = next;
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

  private hasQueuedMessages(conversationId: string): boolean {
    return this.turns.hasQueued(conversationId);
  }

  /** 只判断当前 team turn 之后是否已有用户 turn；handoff 链自身仍属于同一个队列项。 */
  private hasQueuedAhead(conversationId: string, queueId: string | undefined): boolean {
    if (this.turns.queuedCount(conversationId) > 0) return true;
    const activeQueueId = this.turns.activeQueueId(conversationId);
    return queueId !== undefined && activeQueueId !== undefined && activeQueueId !== queueId;
  }

  private startBot({
    conversationId,
    bot,
    trigger,
    getAccessToken,
  }: {
    conversationId: string;
    bot: ConversationBot;
    trigger: { kind: "user"; request: ConversationSendRequest } | { kind: "handoff" };
    getAccessToken: () => Promise<string>;
  }): Promise<AgentRunHandle<ConversationSnapshot>> {
    if (this.closing) throw new Error("会话正在关闭");
    return bot.executor.startRun<ConversationSnapshot>({
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
          onStatus: () => this.pushSnapshot(conversationId),
        }),
      recoverContext: (modelRequest, rebuild, _error, signal) =>
        this.contextPreparation.recoverRequest({
          conversationId,
          getAccessToken,
          modelRequest,
          rebuild,
          signal,
          onStatus: () => this.pushSnapshot(conversationId),
        }),
      prepareRun: async ({ runId, eventRevision }) => {
        const request =
          trigger.kind === "user"
            ? trigger.request
            : {
                text: (
                  await this.store.beginHandoffRun(conversationId, runId, bot.id, eventRevision)
                ).text,
                images: [],
              };
        if (trigger.kind === "user") {
          await this.store.beginRun(
            conversationId,
            runId,
            createUserMessage(randomUUID(), request),
            eventRevision,
            bot.id,
          );
        }
        const snapshot = await this.loadRecoverySnapshot(conversationId);
        await this.pushSnapshotValue(snapshot);
        return {
          input: {
            conversationId,
            runId,
            request,
            profile: bot.policy,
            workspaceRoot: this.workspaceRoot,
            viewerAgentId: bot.id,
            agentNames: new Map(this.catalog.list().map((member) => [member.id, member.name])),
          },
          prepared: snapshot,
        };
      },
      onEvent: (event) => this.applyRunEvent(conversationId, event),
    });
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

  private async applyRunEvent(conversationId: string, envelope: AgentEventEnvelope): Promise<void> {
    await this.store.applyAgentEvent(conversationId, envelope);
    await this.contextPreparation.recordRunEvent(conversationId, envelope.event);
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

  waitForQueue(
    conversationId: string,
    queueId: string,
  ): Promise<{
    queueId: string;
    runId?: string;
    outcome: TurnQueueOutcome;
  }> {
    return this.turns.wait(conversationId, queueId);
  }

  getQueuePosition(conversationId: string, queueId: string): number | undefined {
    return this.turns.position(conversationId, queueId);
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
}

function toQueueOutcome(outcome: string): TurnQueueOutcome {
  if (outcome === "aborted" || outcome === "superseded") return "aborted";
  if (outcome === "failed" || outcome === "orphaned") return "failed";
  return "completed";
}

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
