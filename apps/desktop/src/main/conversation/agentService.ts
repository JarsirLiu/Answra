import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentCommand, AgentFrame, InterviewWorkerEvent } from "@answra/agent";
import type {
  ConversationChange,
  ConversationModelConfig,
  ConversationSendCommand,
  ConversationSendRequest,
  InterviewPcmFrame,
} from "@answra/shared";
import { app, type UtilityProcess, utilityProcess } from "electron";
import type { ResolvedModel } from "./modelRouter";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type RequestCommand = Exclude<AgentCommand, { type: "interview-audio-frame" }>;

/** 云端调用的凭据与端点全部来自主进程（token 只在 main 内存里），agent 不读盘、不落盘。 */
export interface AgentServiceDeps {
  /**
   * 解析本次调用要用的端点与凭据（本地自定义端点或云端订阅，由设置显式选择）。
   * 未登录/未配置时抛错：云端是 `auth-required`，本地是配置提示。
   */
  resolveModel: (options?: { forceRefresh?: boolean }) => Promise<ResolvedModel>;
  log?: (message: string, error?: unknown) => void;
}

export class AgentService {
  private worker?: UtilityProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(change: ConversationChange) => void>();
  private readonly interviewListeners = new Set<(event: InterviewWorkerEvent) => void>();
  private readonly interviewAudioCreditListeners = new Set<
    (credit: { sessionId: string; count: number }) => void
  >();
  /** 已下发给 worker 的配置指纹；配置随登录态变化，按需重下发而不是外部驱动。 */
  private configured?: string;

  constructor(private readonly deps: AgentServiceDeps) {}

  async start(): Promise<void> {
    const workerPath = path.join(app.getAppPath(), "out/main/conversation/worker.cjs");
    const worker = utilityProcess.fork(workerPath, [], {
      cwd: app.getPath("userData"),
      serviceName: "Answra Agent Runtime",
      stdio: "ignore",
    });
    this.worker = worker;
    worker.on("message", (message) => this.onFrame(message as AgentFrame));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.configured = undefined;
      this.failPending(new Error(`本地 AI 服务已退出 (${code})`));
    });
    console.info("[agent-service] started", { pid: worker.pid, packaged: app.isPackaged });
  }

  onChange(listener: (change: ConversationChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onInterviewEvent(listener: (event: InterviewWorkerEvent) => void): () => void {
    this.interviewListeners.add(listener);
    return () => this.interviewListeners.delete(listener);
  }

  onInterviewAudioCredit(
    listener: (credit: { sessionId: string; count: number }) => void,
  ): () => void {
    this.interviewAudioCreditListeners.add(listener);
    return () => this.interviewAudioCreditListeners.delete(listener);
  }

  async send(command: ConversationSendCommand): Promise<{ runId: string }> {
    validateSendRequest(command.request);
    // 来源由设置显式选择：本地端点不需要登录，云端订阅未登录时 resolveModel 抛统一失败码。
    const { config, accessToken } = await this.deps.resolveModel();
    await this.ensureConfigured(config);
    const type = command.operation === "chat.send" ? "chat-send" : "answer-run";
    return (await this.request(type, { ...command, accessToken })) as { runId: string };
  }

  cancel(runId: string): void {
    void this.request("cancel", { runId }).catch((error: unknown) =>
      console.warn("[agent-service] cancel failed", error),
    );
  }

  async getSnapshot(conversationId: string) {
    return this.request("snapshot", { conversationId });
  }

  async createConversation(conversationId: string) {
    return this.request("create-conversation", { conversationId });
  }

  async readEvents(conversationId: string, afterRevision: number) {
    return this.request("read-events", { conversationId, afterRevision });
  }

  async startInterview(sessionId: string, conversationId: string): Promise<void> {
    await this.request("interview-start", { sessionId, conversationId });
  }

  async markInterviewCaptureReady(sessionId: string): Promise<void> {
    await this.request("interview-capture-ready", { sessionId });
  }

  async failInterviewCapture(sessionId: string): Promise<void> {
    await this.request("interview-capture-failed", { sessionId });
  }

  async stopInterview(sessionId: string): Promise<void> {
    await this.request("interview-stop", { sessionId });
  }

  sendInterviewPcmFrame(frame: InterviewPcmFrame): void {
    const worker = this.worker;
    if (!worker) return;
    worker.postMessage({ type: "interview-audio-frame", frame } satisfies AgentCommand);
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.configured = undefined;
    worker.kill();
    this.failPending(new Error("本地 AI 服务已关闭"));
  }

  /** 配置只在真正变化时下发：登录/登出/服务端端点变更都会自然触发一次重下发。 */
  private async ensureConfigured(config: ConversationModelConfig): Promise<void> {
    const fingerprint = JSON.stringify(config);
    if (this.configured === fingerprint) return;
    await this.request("configure", { config });
    this.configured = fingerprint;
  }

  private request(
    type: RequestCommand["type"],
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("本地 AI 服务尚未启动"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload } as AgentCommand);
    });
  }

  private onFrame(frame: AgentFrame): void {
    if (frame.version !== 1) return;
    if (frame.type === "change") {
      for (const listener of this.listeners) listener(frame.change);
      return;
    }
    if (frame.type === "interview-event") {
      for (const listener of this.interviewListeners) listener(frame.event);
      return;
    }
    if (frame.type === "interview-audio-credit") {
      for (const listener of this.interviewAudioCreditListeners)
        listener({ sessionId: frame.sessionId, count: frame.count });
      return;
    }
    // worker 反向请求平台能力（当前只有令牌刷新）：平台实现留在 main，agent 只发请求。
    if (frame.type === "token-request") {
      void this.answerTokenRequest(frame);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.value);
    else pending.reject(new Error(frame.error));
  }

  private async answerTokenRequest(frame: { id: string; forceRefresh: boolean }): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      const { accessToken } = await this.deps.resolveModel({ forceRefresh: frame.forceRefresh });
      worker.postMessage({ id: frame.id, type: "token", accessToken } as AgentCommand);
    } catch (error) {
      const message = error instanceof Error ? error.message : "令牌刷新失败";
      this.deps.log?.("[agent-service] 令牌请求失败", error);
      worker.postMessage({ id: frame.id, type: "token", error: message } as AgentCommand);
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
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
