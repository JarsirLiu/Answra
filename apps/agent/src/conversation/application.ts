/** Conversation application：唯一会话编排循环、transcript 认领与注册 Agent 的执行接线。 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSelection,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEventEnvelope, AgentRunSnapshot } from "@answra/shared/schema";
import type { AgentId, AgentRunHandle } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import type { BotSummary } from "../core/bot/contracts";
import { assertBotDiscoveryReferences, assertCanHandoff } from "../core/bot/directory";
import { validateModelRequest } from "../core/model/requestContent";
import { assertHandoffTask } from "../core/team/handoff";
import {
  assertTeamPreset,
  createTeamPresetCatalog,
  type TeamPreset,
  type TeamPresetCatalog,
} from "../core/team/preset";
import type { ReadFileStateMap } from "../core/tool";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationSessionSeed, ConversationStore } from "../core/transcript/store";
import {
  CONVERSATION_AGENT_ID,
  CONVERSATION_TEAM_ID,
  type ConversationAgentProfile,
} from "./agent";
import type { ConversationBot, ConversationBotCatalog } from "./bots/types";
import { CHAT_PROFILES, type ChatProfileId } from "./profiles/registry";

const MAX_USER_MESSAGE_CHARS = 32_000;

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
  private readonly onSnapshot?: ConversationApplicationOptions["onSnapshot"];
  private readonly onTeamError?: ConversationApplicationOptions["onTeamError"];
  private readonly readFileStates = new Map<string, ReadFileStateMap>();
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
    const snapshot = await this.store.create(conversationId, seed);
    if (
      selection &&
      snapshot.participantAgentIds &&
      !sameParticipants(snapshot.participantAgentIds, seed.participantAgentIds)
    ) {
      throw new Error("会话已存在且 Bot 参与者不同");
    }
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
  async send(
    botId: string | undefined,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    validateModelRequest(request);
    const requested = botId ? this.requireBot(botId) : undefined;
    const seed = this.seedForBot((requested ?? this.requireBot(this.defaultBotId)).id);
    await this.store.create(conversationId, seed);
    const snapshot = await this.loadRecoverySnapshot(conversationId);
    const activeAgentId = snapshot.activeAgentId ?? seed.activeAgentId;
    if (requested && requested.id !== activeAgentId) {
      throw new Error(`会话当前由 ${activeAgentId} 接待，不能直接切换到 ${requested.id}`);
    }
    const entry = this.requireBot(activeAgentId);
    const getAccessToken = async () => accessToken;
    const handle = await this.startBot({
      conversationId,
      bot: entry,
      trigger: { kind: "user", request },
      getAccessToken,
    });
    void this.continueTeamTurn({
      conversationId,
      from: entry,
      handle,
      getAccessToken,
    }).catch((error: unknown) => this.onTeamError?.(error));
    return { runId: handle.runId, snapshot: handle.prepared };
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
  async sendTeamMessage(
    teamId: string,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    validateModelRequest(request);
    const preset = this.presets.require(teamId);
    const seed = this.seedForTeam(preset);
    const snapshot = await this.store.create(conversationId, seed);
    if (
      snapshot.participantAgentIds &&
      !sameParticipants(snapshot.participantAgentIds, seed.participantAgentIds)
    ) {
      throw new Error("会话已存在且 Bot 参与者不同");
    }
    const entry = this.requireBot(snapshot.activeAgentId ?? preset.entryBotId);
    const participants = snapshot.participantAgentIds ?? preset.memberBotIds;
    if (!participants.includes(entry.id)) throw new Error(`Bot 不属于当前会话参与者：${entry.id}`);
    const getAccessToken = async () => accessToken;
    const first = await this.startBot({
      conversationId,
      bot: entry,
      trigger: { kind: "user", request },
      getAccessToken,
    });
    await this.continueTeamTurn({
      conversationId,
      from: entry,
      handle: first,
      getAccessToken,
    });
    return { runId: first.runId, snapshot: await this.loadRecoverySnapshot(conversationId) };
  }

  async replyToLastUser(
    profileId: ChatProfileId,
    conversationId: string,
    getAccessToken: () => Promise<string>,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const profile = CHAT_PROFILES[profileId];
    if (!profile) throw new Error("未授权的对话能力配置");
    const snapshot = await this.store.load(conversationId);
    const bot = this.requireBot(snapshot.activeAgentId ?? this.defaultBotId);
    return this.startReplyRun({ conversationId, bot, profile, getAccessToken });
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
  }): Promise<void> {
    let current = from;
    let currentHandle = handle;
    for (;;) {
      const outcome = await currentHandle.done;
      if (outcome !== "completed") return;
      const result = await currentHandle.result;
      if (!result) return;
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
    return bot.executor.startRun<ConversationSnapshot>({
      conversationId,
      getAccessToken,
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
            readFileState: this.getReadFileState(conversationId),
            viewerAgentId: bot.id,
            agentNames: new Map(this.catalog.list().map((member) => [member.id, member.name])),
          },
          prepared: snapshot,
        };
      },
      onEvent: (event) => this.applyRunEvent(conversationId, event),
    });
  }

  private startReplyRun({
    conversationId,
    bot,
    profile,
    getAccessToken,
  }: {
    conversationId: string;
    bot: ConversationBot;
    profile: ConversationAgentProfile;
    getAccessToken: () => Promise<string>;
  }): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    return bot.executor
      .startRun<ConversationSnapshot>({
        conversationId,
        getAccessToken,
        prepareRun: async ({ runId, eventRevision }) => {
          const target = await this.store.beginReplyRun(
            conversationId,
            runId,
            eventRevision,
            bot.id,
          );
          const snapshot = await this.loadRecoverySnapshot(conversationId);
          await this.pushSnapshotValue(snapshot);
          return {
            input: {
              conversationId,
              runId,
              request: { text: target.text, images: target.images },
              profile,
              workspaceRoot: this.workspaceRoot,
              readFileState: this.getReadFileState(conversationId),
              viewerAgentId: bot.id,
              agentNames: new Map(this.catalog.list().map((member) => [member.id, member.name])),
            },
            prepared: snapshot,
          };
        },
        onEvent: (event) => this.applyRunEvent(conversationId, event),
      })
      .then((handle) => ({ runId: handle.runId, snapshot: handle.prepared }));
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
