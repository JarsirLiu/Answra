import { AgentConnectionSupervisor, type InterviewWorkerEvent } from "@answra/agent";
import type {
  AgentConnectionState,
  ConversationModelConfig,
  ConversationSendCommand,
  ConversationSendRequest,
  ConversationSnapshot,
  InterviewPcmFrame,
} from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import type { ResolvedModel } from "../conversation/modelRouter";
import { AgentWorkerProcess } from "./agentWorkerHost";

/** 重连后要刷新快照的会话上限；截图答题会创建大量一次性会话。 */
const MAX_TRACKED_CONVERSATIONS = 32;

/** 云端调用的凭据与端点全部来自主进程（token 只在 main 内存里），agent 不读盘、不落盘。 */
export interface AgentServiceDeps {
  /**
   * 解析本次调用要用的端点与凭据（本地自定义端点或云端订阅，由设置显式选择）。
   * 未登录/未配置时抛错：云端是 `auth-required`，本地是配置提示。
   */
  resolveModel: (options?: { forceRefresh?: boolean }) => Promise<ResolvedModel>;
  getWorkspaceRoot: () => string | null;
  getInterviewDataRoot: () => string;
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

  onEvent(listener: (event: AgentEventEnvelope) => void): () => void {
    return this.workerHost.onEvent(listener);
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

  async send(command: ConversationSendCommand): Promise<{ runId: string; snapshot: unknown }> {
    if (!__ANSWRA_FEATURE_CHAT__ && command.operation === "chat.send") {
      throw new Error("对话功能不包含在此安装包中");
    }
    validateSendRequest(command.request);
    await this.start();
    this.trackConversation(command.conversationId);
    await this.workerHost.request("workspace-context", { root: this.deps.getWorkspaceRoot() });
    // 来源由设置显式选择：本地端点不需要登录，云端订阅未登录时 resolveModel 抛统一失败码。
    const { config, accessToken } = await this.deps.resolveModel();
    await this.ensureConfigured(config);
    const type = command.operation === "chat.send" ? "chat-send" : "answer-run";
    return (await this.workerHost.request(type, { ...command, accessToken })) as {
      runId: string;
      snapshot: unknown;
    };
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
  ): Promise<{ runId: string; snapshot: ConversationSnapshot }> {
    if (!text.trim() || text.length > 32_000) throw new Error("演练消息无效或过长");
    await this.start();
    this.trackConversation(conversationId);
    await this.workerHost.request("workspace-context", { root: this.deps.getWorkspaceRoot() });
    await this.sendInterviewContext();
    const { config } = await this.deps.resolveModel();
    await this.ensureConfigured(config);
    return (await this.workerHost.request("interview-message", {
      conversationId,
      text,
    })) as { runId: string; snapshot: ConversationSnapshot };
  }

  cancel(runId: string): void {
    void this.workerHost
      .request("cancel", { runId })
      .catch((error: unknown) => console.warn("[agent-service] cancel failed", error));
  }

  async getSnapshot(conversationId: string): Promise<ConversationSnapshot> {
    await this.start();
    this.trackConversation(conversationId);
    return (await this.workerHost.request("snapshot", {
      conversationId,
    })) as ConversationSnapshot;
  }

  async createConversation(conversationId: string) {
    await this.start();
    this.trackConversation(conversationId);
    return this.workerHost.request("create-conversation", { conversationId });
  }

  async clearConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.start();
    this.trackConversation(conversationId);
    return (await this.workerHost.request("clear-conversation", {
      conversationId,
    })) as ConversationSnapshot;
  }

  async readEvents(conversationId: string, afterRevision: number) {
    await this.start();
    this.trackConversation(conversationId);
    return this.workerHost.request("read-events", { conversationId, afterRevision });
  }

  async startInterview(sessionId: string, conversationId: string): Promise<void> {
    // 面试语音会直接触发模型回复：先按普通发送同一门禁准备端点与凭据。
    // 未登录/未配置时显式失败，不进入「只采集不回复」的降级状态。
    await this.start();
    this.trackConversation(conversationId);
    await this.workerHost.request("workspace-context", { root: this.deps.getWorkspaceRoot() });
    await this.sendInterviewContext();
    const { config } = await this.deps.resolveModel();
    await this.ensureConfigured(config);
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

  /** 演练记忆目录由桌面组合根注入；Agent 只拿路径，不自行猜 userData。 */
  private async sendInterviewContext(): Promise<void> {
    await this.workerHost.request("interview-context", { root: this.deps.getInterviewDataRoot() });
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

  /** worker 重启后内存 transcript 为空；按已知会话逐个取权威空快照推给窗口。 */
  private async refreshKnownSnapshots(): Promise<void> {
    for (const conversationId of [...this.knownConversationIds]) {
      try {
        const snapshot = (await this.workerHost.request("snapshot", {
          conversationId,
        })) as ConversationSnapshot;
        this.workerHost.publishSnapshot(snapshot);
      } catch (error) {
        this.deps.log?.("[agent-service] 重连后刷新会话快照失败", error);
      }
    }
  }
}

function validateSendRequest(request: ConversationSendRequest): void {
  if (typeof request.text !== "string" || request.text.length > 32_000)
    throw new Error("消息内容无效或过长");
  if (!Array.isArray(request.images) || request.images.length > 8)
    throw new Error("单次最多发送 8 张图片");
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  for (const image of request.images) {
    if (
      typeof image.name !== "string" ||
      image.name.length > 256 ||
      typeof image.dataUrl !== "string" ||
      image.dataUrl.length > 11_200_000
    )
      throw new Error("图片附件无效或过大");
    const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if (!match?.[1] || !allowedTypes.has(match[1]) || !match[2])
      throw new Error("图片格式仅支持 PNG、JPEG、WebP 或 GIF");
  }
}
