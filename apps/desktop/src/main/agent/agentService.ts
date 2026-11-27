import { AgentConnectionSupervisor, type InterviewWorkerEvent } from "@answra/agent";
import {
  ActiveInterviewAssistConversationId,
  ActiveInterviewConversationId,
  ActiveInterviewIntakeConversationId,
  type AgentConnectionState,
  type BotSummary,
  type ConversationImage,
  type ConversationModelConfig,
  type ConversationSelection,
  type ConversationSendCommand,
  type ConversationSendRequest,
  type ConversationSendResponse,
  type ConversationSessionPage,
  type ConversationSessionScope,
  type ConversationSnapshot,
  emptyInterviewProfileSeed,
  type InterviewChatOpenResult,
  type InterviewIntakeOpenResult,
  type InterviewPcmFrame,
  type InterviewProfileSeed,
  type ManualCompactionResult,
} from "@answra/shared";
import type { LiveFrame, SessionFrame } from "@answra/shared/schema";
import type { ResolvedModel } from "../conversation/modelRouter";
import { AgentWorkerProcess } from "./agentWorkerHost";
import { parseConversationImages } from "./conversationImages";

/** 重连后要刷新快照的会话上限；截图答题会创建大量一次性会话。 */
const MAX_TRACKED_CONVERSATIONS = 32;

/** 云端调用的凭据与端点全部来自主进程（token 只在 main 内存里），agent 不读盘、不落盘。 */
export interface AgentServiceDeps {
  /**
   * 解析本次调用要用的端点与凭据（本地自定义端点或云端订阅，由设置显式选择）。
   * 未登录/未配置时抛错：云端是 `auth-required`，本地是配置提示。
   */
  resolveModel: (options?: { forceRefresh?: boolean }) => Promise<ResolvedModel>;
  /** 机会式解析：打开会话时若模型未就绪就跳过，不抛用户可见失败。 */
  resolveModelIfReady?: () => Promise<ResolvedModel | undefined>;
  getWorkspaceRoot: () => string | null;
  getInterviewDataRoot: () => string;
  /** 读取最近一次引导输入；画像由 Agent 维护，这里只提供只读种子。 */
  readInterviewProfileSeed?: () => Promise<InterviewProfileSeed>;
  log?: (message: string, error?: unknown) => void;
}

/**
 * 对话/面试用例与 Agent worker 组合面：连接生命周期交给连接域，
 * worker 进程细节交给 `AgentWorkerProcess`，本类只保留领域命令与配置重下发。
 */
export class AgentService {
  private readonly workerHost: AgentWorkerProcess;
  private readonly knownConversationIds = new Set<string>();
  private readonly connection: AgentConnectionSupervisor;
  private lastConnectionState?: AgentConnectionState;
  /** 已下发给 worker 的配置指纹；配置随登录态变化，按需重下发而不是外部驱动。 */
  private configured?: string;

  constructor(private readonly deps: AgentServiceDeps) {
    this.workerHost = new AgentWorkerProcess({
      resolveModel: deps.resolveModel,
      log: deps.log,
    });
    this.connection = new AgentConnectionSupervisor(this.workerHost);
    this.connection.subscribe((state) => {
      const previous = this.lastConnectionState;
      this.lastConnectionState = state;
      // 新 worker 没有旧配置；下一次发送必须重新下发模型端点与凭据。
      if (state.status !== "connected") this.configured = undefined;
      // 重连成功后旧 worker 的内存 transcript 已丢失：主动发布空快照，让各窗口回到权威状态。
      if (
        state.status === "connected" &&
        previous !== undefined &&
        previous.status !== "connected"
      ) {
        void this.refreshKnownSnapshots().catch((error: unknown) => {
          this.deps.log?.("[agent-service] 重连后刷新会话快照失败", error);
        });
      }
    });
  }

  /** 启动或复用 Agent worker；失败时按连接域统一错误上抛。 */
  async start(): Promise<void> {
    await this.connection.ensureStarted();
  }

  getConnectionState(): AgentConnectionState {
    return this.connection.getState();
  }

  onConnectionState(listener: (state: AgentConnectionState) => void): () => void {
    return this.connection.subscribe(listener);
  }

  onSessionFrame(listener: (frame: SessionFrame) => void): () => void {
    return this.workerHost.onSessionFrame(listener);
  }

  onLiveFrame(listener: (frame: LiveFrame) => void): () => void {
    return this.workerHost.onLiveFrame(listener);
  }

  onSnapshot(listener: (snapshot: ConversationSnapshot) => void): () => void {
    return this.workerHost.onSnapshot(listener);
  }

  onInterviewEvent(listener: (event: InterviewWorkerEvent) => void): () => void {
    return this.workerHost.onInterviewEvent(listener);
  }

  onInterviewAudioCredit(
    listener: (credit: { sessionId: string; count: number }) => void,
  ): () => void {
    return this.workerHost.onInterviewAudioCredit(listener);
  }

  async send(command: ConversationSendCommand): Promise<ConversationSendResponse> {
    if (
      !__ANSWRA_FEATURE_CHAT__ &&
      (command.operation === "chat.send" || command.operation === "team.send")
    ) {
      throw new Error("对话功能不包含在此安装包中");
    }
    validateSendRequest(command.request);
    await this.start();
    this.trackConversation(command.conversationId);
    await this.workerHost.request("workspace-context", { root: this.deps.getWorkspaceRoot() });
    // 来源由设置显式选择：本地端点不需要登录，云端订阅未登录时 resolveModel 抛统一失败码。
    const { config, accessToken } = await this.deps.resolveModel();
    await this.ensureConfigured(config);
    const type =
      command.operation === "chat.send"
        ? "chat-send"
        : command.operation === "team.send"
          ? "team-send"
          : "answer-send";
    return (await this.workerHost.request(type, {
      ...command,
      accessToken,
    })) as ConversationSendResponse;
  }

  async waitForConversationQueue(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; turnId?: string; outcome: "completed" | "failed" | "aborted" }> {
    await this.start();
    this.trackConversation(conversationId);
    return (await this.workerHost.request("wait-queue", { conversationId, queueId })) as {
      queueId: string;
      turnId?: string;
      outcome: "completed" | "failed" | "aborted";
    };
  }

  async waitForConversationQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; turnId: string; snapshot: ConversationSnapshot }> {
    await this.start();
    this.trackConversation(conversationId);
    return (await this.workerHost.request("wait-queue-start", { conversationId, queueId })) as {
      queueId: string;
      turnId: string;
      snapshot: ConversationSnapshot;
    };
  }

  async getConversationQueuePosition(
    conversationId: string,
    queueId: string,
  ): Promise<number | undefined> {
    await this.start();
    return (await this.workerHost.request("queue-position", { conversationId, queueId })) as
      | number
      | undefined;
  }

  async appendUserMessage(conversationId: string, text: string) {
    if (!text.trim() || text.length > 32_000) throw new Error("消息内容无效或过长");
    await this.start();
    this.trackConversation(conversationId);
    return this.workerHost.request("append-user-message", { conversationId, text });
  }

  async sendInterviewMessage(
    conversationId: string,
    text: string,
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    if (!text.trim() || text.length > 32_000) throw new Error("演练消息无效或过长");
    await this.start();
    this.trackConversation(conversationId);
    await this.prepareInterviewModel();
    return (await this.workerHost.request("interview-message", {
      conversationId,
      text,
    })) as { turnId: string; snapshot: ConversationSnapshot };
  }

  async getInterviewRehearsalSnapshot(): Promise<ConversationSnapshot> {
    await this.start();
    this.trackConversation(ActiveInterviewConversationId);
    return (await this.workerHost.request("interview-snapshot", {
      conversationId: ActiveInterviewConversationId,
    })) as ConversationSnapshot;
  }

  async openInterviewRehearsal(): Promise<InterviewChatOpenResult> {
    await this.start();
    this.trackConversation(ActiveInterviewConversationId);
    await this.prepareInterviewContext();
    return (await this.workerHost.request("interview-rehearsal-open", {
      conversationId: ActiveInterviewConversationId,
    })) as InterviewChatOpenResult;
  }

  async openInterviewAssist(): Promise<InterviewChatOpenResult> {
    await this.start();
    this.trackConversation(ActiveInterviewAssistConversationId);
    await this.prepareInterviewContext();
    return (await this.workerHost.request("interview-assist-open", {
      conversationId: ActiveInterviewAssistConversationId,
    })) as InterviewChatOpenResult;
  }

  async sendInterviewAssistMessage(
    text: string,
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    if (!text.trim() || text.length > 32_000) throw new Error("面试辅助消息无效或过长");
    await this.start();
    this.trackConversation(ActiveInterviewAssistConversationId);
    await this.prepareInterviewModel();
    return (await this.workerHost.request("interview-assist-message", {
      conversationId: ActiveInterviewAssistConversationId,
      text,
    })) as { turnId: string; snapshot: ConversationSnapshot };
  }

  async getInterviewAssistSnapshot(): Promise<ConversationSnapshot> {
    await this.start();
    this.trackConversation(ActiveInterviewAssistConversationId);
    return (await this.workerHost.request("interview-assist-snapshot", {
      conversationId: ActiveInterviewAssistConversationId,
    })) as ConversationSnapshot;
  }

  async openInterviewIntake(): Promise<InterviewIntakeOpenResult> {
    await this.start();
    this.trackConversation(ActiveInterviewIntakeConversationId);
    await this.prepareInterviewContext();
    return (await this.workerHost.request("interview-intake-open", {
      conversationId: ActiveInterviewIntakeConversationId,
    })) as InterviewIntakeOpenResult;
  }

  async sendInterviewIntakeMessage(
    text: string,
    images: ConversationImage[],
  ): Promise<{ turnId: string; snapshot: ConversationSnapshot }> {
    if (text.length > 32_000 || (!text.trim() && images.length === 0))
      throw new Error("面试消息无效或过长");
    await this.start();
    this.trackConversation(ActiveInterviewIntakeConversationId);
    await this.prepareInterviewModel();
    return (await this.workerHost.request("interview-intake-message", {
      conversationId: ActiveInterviewIntakeConversationId,
      text,
      images,
    })) as { turnId: string; snapshot: ConversationSnapshot };
  }

  async getInterviewIntakeSnapshot(): Promise<ConversationSnapshot> {
    await this.start();
    this.trackConversation(ActiveInterviewIntakeConversationId);
    return (await this.workerHost.request("interview-intake-snapshot", {
      conversationId: ActiveInterviewIntakeConversationId,
    })) as ConversationSnapshot;
  }

  /** 取消指定 Turn；会话/面试/Coding/Answer 共用。 */
  cancelTurn(conversationId: string, turnId: string): void {
    void this.workerHost
      .request("cancel-turn", { conversationId, turnId })
      .catch((error: unknown) => console.warn("[agent-service] cancel-turn failed", error));
  }

  async listBots(): Promise<BotSummary[]> {
    await this.start();
    return (await this.workerHost.request("bot-list", {})) as BotSummary[];
  }

  async listConversationSessions(query?: {
    scope?: ConversationSessionScope;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationSessionPage> {
    await this.start();
    return (await this.workerHost.request("session-list", {
      ...(query === undefined ? {} : { query }),
    })) as ConversationSessionPage;
  }

  async deleteConversationSession(conversationId: string): Promise<void> {
    await this.start();
    await this.workerHost.request("session-delete", { conversationId });
    this.knownConversationIds.delete(conversationId);
  }

  async getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    await this.start();
    this.trackConversation(conversationId);
    return (await this.workerHost.request(snapshotCommandFor(conversationId), {
      conversationId,
    })) as ConversationSnapshot;
  }

  async createConversation(
    conversationId: string,
    selection?: ConversationSelection,
  ): Promise<ConversationSnapshot> {
    await this.start();
    this.trackConversation(conversationId);
    return (await this.workerHost.request("create-conversation", {
      conversationId,
      selection,
    })) as ConversationSnapshot;
  }

  async createAnswerConversation(conversationId: string) {
    await this.start();
    this.trackConversation(conversationId);
    return this.workerHost.request("create-answer-conversation", { conversationId });
  }

  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.start();
    this.trackConversation(conversationId);
    return (await this.workerHost.request("clear-conversation", {
      conversationId,
    })) as ConversationSnapshot;
  }

  async compactConversation(
    conversationId: string,
    instructions?: string,
  ): Promise<{ result: ManualCompactionResult; snapshot: ConversationSnapshot }> {
    await this.start();
    this.trackConversation(conversationId);
    await this.workerHost.request("workspace-context", { root: this.deps.getWorkspaceRoot() });
    const { config, accessToken } = await this.deps.resolveModel();
    await this.ensureConfigured(config);
    return (await this.workerHost.request("compact-conversation", {
      conversationId,
      accessToken,
      ...(instructions === undefined ? {} : { instructions }),
    })) as { result: ManualCompactionResult; snapshot: ConversationSnapshot };
  }

  async readFrames(conversationId: string, afterSeq: number): Promise<SessionFrame[]> {
    await this.start();
    this.trackConversation(conversationId);
    return (await this.workerHost.request("read-frames", {
      conversationId,
      afterSeq,
    })) as SessionFrame[];
  }

  async startInterview(sessionId: string, conversationId: string): Promise<void> {
    // 面试语音会直接触发模型回复：先按普通发送同一门禁准备端点与凭据。
    // 未登录/未配置时显式失败，不进入「只采集不回复」的降级状态。
    await this.start();
    this.trackConversation(conversationId);
    await this.prepareInterviewModel();
    await this.workerHost.request("interview-start", { sessionId, conversationId });
  }

  async markInterviewCaptureReady(sessionId: string): Promise<void> {
    await this.start();
    await this.workerHost.request("interview-capture-ready", { sessionId });
  }

  async failInterviewCapture(sessionId: string): Promise<void> {
    await this.start();
    await this.workerHost.request("interview-capture-failed", { sessionId });
  }

  async stopInterview(sessionId: string): Promise<void> {
    await this.start();
    await this.workerHost.request("interview-stop", { sessionId });
  }

  sendInterviewPcmFrame(frame: InterviewPcmFrame): void {
    this.workerHost.sendInterviewPcmFrame(frame);
  }

  async stop(): Promise<void> {
    await this.connection.dispose();
  }

  /**
   * 打开面试会话只下发工作区与画像种子，不解析模型配置：
   * 面板打开不是模型调用，云端未登录时不应该在这里抛 auth-required。
   * 本地与云端两种来源都保留，真正调用模型时由发送路径统一解析。
   */
  private async prepareInterviewContext(): Promise<void> {
    await this.workerHost.request("workspace-context", { root: this.deps.getWorkspaceRoot() });
    await this.sendInterviewContext();
    // 有可用模型就顺手下发，让空会话能生成开场提问；未登录/未配置时跳过，
    // 由 Agent 侧.open() 直接恢复空页面，真正的失败留到发送路径呈现。
    const resolved = await this.deps.resolveModelIfReady?.();
    if (resolved) await this.ensureConfigured(resolved.config);
  }

  /** 面试发送/语音启动前才解析模型：本地直接可用，云端沿用同一登录门禁。 */
  private async prepareInterviewModel(): Promise<void> {
    await this.prepareInterviewContext();
    const { config } = await this.deps.resolveModel();
    await this.ensureConfigured(config);
  }

  /** 演练记忆目录由桌面组合根注入；Agent 只拿路径，不自行猜 userData。 */
  private async sendInterviewContext(): Promise<void> {
    const seed = await this.readProfileSeed();
    await this.workerHost.request("interview-context", {
      root: this.deps.getInterviewDataRoot(),
      seed,
    });
  }

  private async readProfileSeed(): Promise<InterviewProfileSeed> {
    if (!this.deps.readInterviewProfileSeed) return emptyInterviewProfileSeed();
    try {
      return await this.deps.readInterviewProfileSeed();
    } catch (error) {
      this.deps.log?.("[agent-service] 读取引导画像种子失败", error);
      return emptyInterviewProfileSeed();
    }
  }

  /** 配置只在真正变化时下发：登录/登出/服务端端点变更都会自然触发一次重下发。 */
  private async ensureConfigured(config: ConversationModelConfig): Promise<void> {
    const fingerprint = JSON.stringify(config);
    if (this.configured === fingerprint) return;
    await this.workerHost.request("configure", { config });
    this.configured = fingerprint;
  }

  private trackConversation(conversationId: string): void {
    this.knownConversationIds.delete(conversationId);
    this.knownConversationIds.add(conversationId);
    while (this.knownConversationIds.size > MAX_TRACKED_CONVERSATIONS) {
      const oldest = this.knownConversationIds.values().next().value;
      if (oldest === undefined) return;
      this.knownConversationIds.delete(oldest);
    }
  }

  /** worker 重启后内存 transcript 为空；按已知会话逐个取权威快照推给窗口。 */
  private async refreshKnownSnapshots(): Promise<void> {
    for (const conversationId of [...this.knownConversationIds]) {
      try {
        const snapshot = (await this.workerHost.request(snapshotCommandFor(conversationId), {
          conversationId,
        })) as ConversationSnapshot;
        this.workerHost.publishSnapshot(snapshot);
      } catch (error) {
        this.deps.log?.("[agent-service] 重连后刷新会话快照失败", error);
      }
    }
  }
}

/** 固定面试会话必须走所属领域的恢复；conversation 运行时不能替其他领域执行恢复。 */
function snapshotCommandFor(conversationId: string) {
  if (conversationId === ActiveInterviewConversationId) return "interview-snapshot" as const;
  if (conversationId === ActiveInterviewAssistConversationId)
    return "interview-assist-snapshot" as const;
  if (conversationId === ActiveInterviewIntakeConversationId)
    return "interview-intake-snapshot" as const;
  return "snapshot" as const;
}

function validateSendRequest(request: ConversationSendRequest): void {
  if (typeof request.text !== "string" || request.text.length > 32_000)
    throw new Error("消息内容无效或过长");
  parseConversationImages(request.images);
}
