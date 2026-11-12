/** CLI coding 单 Bot 会话用例：创建、发送、取消与 transcript 更新；不包含 team/handoff。 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import type { AgentRunHandle } from "../core/agent/definition";
import type { AgentRuntime } from "../core/agent/runtime";
import { validateModelRequest } from "../core/model/requestContent";
import type { ReadFileStateMap } from "../core/tool";
import { createUserMessage } from "../core/transcript/message";
import type { ConversationSessionSeed, ConversationStore } from "../core/transcript/store";
import type { CodingBot } from "./bot";

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
  private readonly onSnapshot?: CodingApplicationOptions["onSnapshot"];
  private readonly readFileStates = new Map<string, ReadFileStateMap>();
  private workspaceRoot: string | null = null;

  constructor({ agentRuntime, store, bot, onSnapshot }: CodingApplicationOptions) {
    if (bot.domain !== "coding") throw new Error(`不是 coding Bot：${bot.id}`);
    this.agentRuntime = agentRuntime;
    this.store = store;
    this.bot = bot;
    this.onSnapshot = onSnapshot;
  }

  setWorkspaceRoot(root: string | null): void {
    this.workspaceRoot = root;
  }

  async createConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.create(conversationId, this.seed());
    this.readFileStates.delete(conversationId);
    return this.store.load(conversationId);
  }

  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    const eventRevision = await this.agentRuntime.getConversationRevision(conversationId);
    await this.store.clear(conversationId, eventRevision);
    this.readFileStates.delete(conversationId);
    return this.store.load(conversationId);
  }

  getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    return this.store.load(conversationId);
  }

  readEventsAfter(conversationId: string, revision: number): Promise<AgentEventEnvelope[]> {
    return this.agentRuntime.readEvents(conversationId, revision);
  }

  async send(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    validateModelRequest(request);
    if (!request.text.trim()) throw new Error("消息内容不能为空");
    if (request.images.length > 0) throw new Error("CLI coding 暂不支持图片输入");
    await this.store.create(conversationId, this.seed());
    const getAccessToken = async () => accessToken;
    const handle = await this.startRun({ conversationId, request, getAccessToken });
    return { runId: handle.runId, snapshot: handle.prepared };
  }

  configure(config: ConversationModelConfig): void {
    this.agentRuntime.configureModelRoutes({ chat: config.chat, answer: config.answer });
  }

  cancel(runId: string): void {
    this.agentRuntime.cancel(runId);
  }

  waitForRun(runId: string): Promise<void> {
    return this.agentRuntime.waitForRun(runId);
  }

  dispose(): void {
    this.readFileStates.clear();
    this.agentRuntime.dispose();
  }

  get activeRunCount(): number {
    return this.agentRuntime.activeRunCount;
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
    return this.bot.executor.startRun<ConversationSnapshot>({
      conversationId,
      getAccessToken,
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
            readFileState: this.getReadFileState(conversationId),
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
  }

  private getReadFileState(conversationId: string): ReadFileStateMap {
    const existing = this.readFileStates.get(conversationId);
    if (existing) return existing;
    const state: ReadFileStateMap = new Map();
    this.readFileStates.set(conversationId, state);
    return state;
  }
}
