/** Conversation application：唯一会话编排循环、transcript 认领与注册 Agent 的执行接线。 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEventEnvelope, AgentRunSnapshot } from "@answra/shared/schema";
import type { AgentExecutor, AgentId, AgentRunHandle } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import { validateModelRequest } from "../core/model/requestContent";
import { assertCanHandoff, assertHandoffTask, assertTeamDefinition } from "../core/team/directory";
import type { ReadFileStateMap } from "../core/tool";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationSessionSeed, ConversationStore } from "../core/transcript/store";
import {
  CONVERSATION_AGENT_ID,
  CONVERSATION_TEAM_ID,
  type ConversationAgentInput,
  type ConversationAgentProfile,
  GENERAL_DISCOVERY,
  GENERAL_IDENTITY,
} from "./agent";
import { CHAT_PROFILES, type ChatProfileId } from "./profiles/registry";
import {
  type ConversationBot,
  type ConversationTeam,
  createConversationTeam,
  createTeamCatalog,
} from "./team";

const MAX_USER_MESSAGE_CHARS = 32_000;

export interface ConversationApplicationOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  conversationAgent?: AgentExecutor<ConversationAgentInput>;
  /** 已装配团队；缺省时用 conversationAgent 构造一个单成员 conversation 团队。 */
  teams?: readonly ConversationTeam[];
  /** 每段 run 启动与交接写入后的权威 snapshot 推送。 */
  onSnapshot?: (snapshot: ConversationSnapshot) => void | Promise<void>;
  /** 后台交接链失败；不静默吞掉，也不伪造第二条 AI 消息。 */
  onTeamError?: (error: unknown) => void;
}

export class ConversationApplication {
  private readonly agentRuntime: AgentRuntime;
  private readonly store: ConversationStore;
  private readonly teams: readonly ConversationTeam[];
  private readonly teamCatalog: ReturnType<typeof createTeamCatalog>;
  private readonly defaultTeam?: ConversationTeam;
  private readonly onSnapshot?: ConversationApplicationOptions["onSnapshot"];
  private readonly onTeamError?: ConversationApplicationOptions["onTeamError"];
  private readonly readFileStates = new Map<string, ReadFileStateMap>();
  private workspaceRoot: string | null = null;

  constructor({
    agentRuntime,
    store,
    conversationAgent,
    teams = [],
    onSnapshot,
    onTeamError,
  }: ConversationApplicationOptions) {
    this.agentRuntime = agentRuntime;
    this.store = store;
    this.onSnapshot = onSnapshot;
    this.onTeamError = onTeamError;

    const configured = [...teams];
    if (
      !configured.some((team) => team.definition.teamId === CONVERSATION_TEAM_ID) &&
      conversationAgent
    ) {
      configured.push(
        createConversationTeam({
          teamId: CONVERSATION_TEAM_ID,
          entryAgentId: CONVERSATION_AGENT_ID,
          bots: [
            {
              agentId: CONVERSATION_AGENT_ID,
              identity: GENERAL_IDENTITY,
              discovery: GENERAL_DISCOVERY,
              executor: conversationAgent,
              profile: CHAT_PROFILES["general-chat"],
            },
          ],
        }),
      );
    }
    this.teams = configured;
    this.teamCatalog = createTeamCatalog(configured);
    for (const team of configured) {
      this.agentRuntime.assertTeamMembers(
        team.definition.entryAgentId,
        team.definition.memberAgentIds,
      );
      assertTeamDefinition(team.definition, this.teamCatalog);
    }
    this.defaultTeam = configured.find((team) => team.definition.teamId === CONVERSATION_TEAM_ID);
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
    await this.store.create(conversationId, this.defaultSeed());
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

  /** `chat-send` 的迁移入口：使用 conversation 团队入口 Bot，响应保持首段 run。 */
  async sendChat(
    profileId: ChatProfileId,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const profile = CHAT_PROFILES[profileId];
    if (!profile) throw new Error("未授权的对话能力配置");
    validateModelRequest(request);
    return this.startTeamTurn({
      conversationId,
      team: this.requireDefaultTeam(),
      request,
      getAccessToken: async () => accessToken,
      waitForIdle: false,
      profile,
    });
  }

  /** `team-send`：显式团队入口；等待整条交接链回到 idle 后返回最终 snapshot。 */
  async sendTeamMessage(
    teamId: string,
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    validateModelRequest(request);
    const team = this.teams.find((item) => item.definition.teamId === teamId);
    if (!team) throw new Error(`团队未注册：${teamId}`);
    return this.startTeamTurn({
      conversationId,
      team,
      request,
      getAccessToken: async () => accessToken,
      waitForIdle: true,
    });
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
    const team = this.requireDefaultTeam();
    const bot = this.requireBot(team, team.definition.entryAgentId);
    return this.startReplyRun({ conversationId, team, bot, profile, getAccessToken });
  }

  private async startTeamTurn({
    conversationId,
    team,
    request,
    getAccessToken,
    waitForIdle,
    profile,
  }: {
    conversationId: string;
    team: ConversationTeam;
    request: ConversationSendRequest;
    getAccessToken: () => Promise<string>;
    waitForIdle: boolean;
    profile?: ConversationAgentProfile;
  }): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    const entry = this.requireBot(team, team.definition.entryAgentId);
    await this.store.create(conversationId, this.seedFor(team));
    const first = await this.startBot({
      conversationId,
      team,
      bot: entry,
      trigger: { kind: "user", request },
      getAccessToken,
      ...(profile ? { profile } : {}),
    });
    const loop = this.continueTeamTurn({
      conversationId,
      team,
      from: entry,
      handle: first,
      getAccessToken,
    });
    if (!waitForIdle) {
      void loop.catch((error: unknown) => this.onTeamError?.(error));
      return { runId: first.runId, snapshot: first.prepared };
    }
    await loop;
    return { runId: first.runId, snapshot: await this.loadRecoverySnapshot(conversationId) };
  }

  private async continueTeamTurn({
    conversationId,
    team,
    from,
    handle,
    getAccessToken,
  }: {
    conversationId: string;
    team: ConversationTeam;
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
      assertCanHandoff(team.definition, current.agentId, result.to, this.teamCatalog);
      await this.store.appendHandoffMessage(conversationId, {
        id: randomUUID(),
        fromAgentId: current.agentId,
        toAgentId: result.to,
        task: result.task,
      });
      await this.pushSnapshot(conversationId);
      const next = this.requireBot(team, result.to);
      currentHandle = await this.startBot({
        conversationId,
        team,
        bot: next,
        trigger: { kind: "handoff" },
        getAccessToken,
      });
      current = next;
    }
  }

  private startBot({
    conversationId,
    team,
    bot,
    trigger,
    getAccessToken,
    profile,
  }: {
    conversationId: string;
    team: ConversationTeam;
    bot: ConversationBot;
    trigger: { kind: "user"; request: ConversationSendRequest } | { kind: "handoff" };
    getAccessToken: () => Promise<string>;
    profile?: ConversationAgentProfile;
  }): Promise<AgentRunHandle<ConversationSnapshot>> {
    const activeProfile = profile ?? bot.profile;
    return bot.executor.startRun<ConversationSnapshot>({
      conversationId,
      getAccessToken,
      prepareRun: async ({ runId, eventRevision }) => {
        const request =
          trigger.kind === "user"
            ? trigger.request
            : {
                text: (await this.claimHandoff(conversationId, runId, bot.agentId, eventRevision))
                  .text,
                images: [],
              };
        if (trigger.kind === "user") {
          await this.store.create(conversationId, this.seedFor(team));
          await this.store.beginRun(
            conversationId,
            runId,
            createUserMessage(randomUUID(), request),
            eventRevision,
            bot.agentId,
          );
        }
        const snapshot = await this.loadRecoverySnapshot(conversationId);
        await this.pushSnapshotValue(snapshot);
        const agentNames = new Map(
          [...team.bots.values()].map((member) => [member.agentId, member.identity.name]),
        );
        return {
          input: {
            conversationId,
            runId,
            request,
            profile: activeProfile,
            workspaceRoot: this.workspaceRoot,
            readFileState: this.getReadFileState(conversationId),
            viewerAgentId: bot.agentId,
            agentNames,
          },
          prepared: snapshot,
        };
      },
      onEvent: (event) => this.applyRunEvent(conversationId, event),
    });
  }

  private claimHandoff(
    conversationId: string,
    runId: string,
    targetAgentId: string,
    eventRevision: number,
  ) {
    return this.store.beginHandoffRun(conversationId, runId, targetAgentId, eventRevision);
  }

  private startReplyRun({
    conversationId,
    team,
    bot,
    profile,
    getAccessToken,
  }: {
    conversationId: string;
    team: ConversationTeam;
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
            bot.agentId,
          );
          const snapshot = await this.loadRecoverySnapshot(conversationId);
          await this.pushSnapshotValue(snapshot);
          const agentNames = new Map(
            [...team.bots.values()].map((member) => [member.agentId, member.identity.name]),
          );
          return {
            input: {
              conversationId,
              runId,
              request: { text: target.text, images: target.images },
              profile,
              workspaceRoot: this.workspaceRoot,
              readFileState: this.getReadFileState(conversationId),
              viewerAgentId: bot.agentId,
              agentNames,
            },
            prepared: snapshot,
          };
        },
        onEvent: (event) => this.applyRunEvent(conversationId, event),
      })
      .then((handle) => ({ runId: handle.runId, snapshot: handle.prepared }));
  }

  private requireDefaultTeam(): ConversationTeam {
    if (!this.defaultTeam) throw new Error("Conversation Agent 未注册");
    return this.defaultTeam;
  }

  private requireBot(team: ConversationTeam, agentId: AgentId): ConversationBot {
    const bot = team.bots.get(agentId);
    if (!bot) throw new Error(`Bot 未注册：${agentId}`);
    return bot;
  }

  private defaultSeed(): ConversationSessionSeed | undefined {
    return this.defaultTeam ? this.seedFor(this.defaultTeam) : undefined;
  }

  private seedFor(team: ConversationTeam): ConversationSessionSeed {
    return {
      activeAgentId: team.definition.entryAgentId,
      participantAgentIds: team.definition.memberAgentIds,
      bots: [...team.bots.values()].map((bot) => ({
        id: bot.agentId,
        name: bot.identity.name,
        role: bot.identity.role,
      })),
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
