/** CLI coding 的单 Bot 会话用例：打开、发送、等待与取消；不涉及 TUI 或进程 I/O。 */
import { randomUUID } from "node:crypto";
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSendResult,
  ConversationSessionPage,
  ConversationSessionSummary,
  ConversationSnapshot,
  ManualCompactionResult,
} from "@answra/shared";
import type { ImageAttachment } from "../image/attachment";

/** 手动压缩的可选输入；指令只影响本次摘要，不写入会话或配置。 */
export interface ManualCompactionOptions {
  signal?: AbortSignal;
  instructions?: string;
}

/** 会话用例所需的最小宿主端口；由 adapters 映射到 @answra/agent/composition。 */
export interface CodingSessionHost {
  configure(model: ConversationModelConfig): void;
  createConversation(conversationId: string): Promise<ConversationSnapshot>;
  getSnapshot?(conversationId: string): Promise<ConversationSnapshot>;
  listSessions?(query: {
    workspaceRoot?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationSessionPage>;
  getSession?(
    conversationId: string,
    workspaceRoot?: string,
  ): Promise<ConversationSessionSummary | undefined>;
  deleteSession?(conversationId: string): Promise<void>;
  clearConversation(conversationId: string): Promise<ConversationSnapshot>;
  compactConversation?(
    conversationId: string,
    accessToken: string,
    options?: ManualCompactionOptions,
  ): Promise<{ result: ManualCompactionResult; snapshot: ConversationSnapshot }>;
  send(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string }>;
  enqueue(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<ConversationSendResult>;
  waitForQueueStart(
    conversationId: string,
    queueId: string,
  ): Promise<{ queueId: string; runId: string; snapshot: ConversationSnapshot }>;
  cancel(runId: string): void;
  waitForRun(runId: string): Promise<void>;
  dispose(): void;
  shutdown?(): Promise<void>;
}

export interface CodingSessionOptions {
  host: CodingSessionHost;
  conversationId: string;
  createConversationId?: () => string;
  model: ConversationModelConfig;
  accessToken: string;
  workspaceRoot?: string;
}

/** 单活动 run 状态机；并发发送在进入 Agent 之前即被拒绝。 */
export class CodingSession {
  private readonly host: CodingSessionHost;
  private readonly createConversationId: () => string;
  private readonly workspaceRoot?: string;
  private conversationId: string;
  private model: ConversationModelConfig;
  private accessToken: string;
  private opened = false;
  private closed = false;
  private snapshot?: ConversationSnapshot;
  private sending = false;
  private activeRunId?: string;

  constructor({
    host,
    conversationId,
    createConversationId,
    model,
    accessToken,
    workspaceRoot,
  }: CodingSessionOptions) {
    this.host = host;
    this.conversationId = conversationId;
    this.createConversationId = createConversationId ?? randomUUID;
    this.workspaceRoot = workspaceRoot;
    this.model = model;
    this.accessToken = accessToken;
  }

  get currentConversationId(): string {
    return this.conversationId;
  }

  get modelConfig(): ConversationModelConfig {
    return this.model;
  }

  async open(): Promise<ConversationSnapshot> {
    if (this.closed) throw new Error("会话已关闭。");
    if (this.snapshot !== undefined) return this.snapshot;
    this.host.configure(this.model);
    const snapshot = await this.host.createConversation(this.conversationId);
    this.snapshot = snapshot;
    this.opened = true;
    return snapshot;
  }

  async startNewConversation(): Promise<ConversationSnapshot> {
    this.requireIdle("新建会话");
    const conversationId = this.createConversationId();
    const snapshot = await this.host.createConversation(conversationId);
    this.conversationId = conversationId;
    this.snapshot = snapshot;
    this.opened = true;
    return snapshot;
  }

  /** 读取当前会话的最新内存/持久化快照；用于运行中切回时补齐后台流式内容。 */
  async refresh(): Promise<ConversationSnapshot> {
    if (this.closed) throw new Error("会话已关闭。");
    if (!this.opened) return this.open();
    if (this.host.getSnapshot === undefined) throw new Error("当前宿主不支持读取会话快照。");
    const snapshot = await this.host.getSnapshot(this.conversationId);
    this.snapshot = snapshot;
    return snapshot;
  }

  async resume(conversationId: string): Promise<ConversationSnapshot> {
    this.requireIdle("恢复会话");
    if (this.host.getSnapshot === undefined) throw new Error("当前宿主不支持恢复会话。");
    const snapshot = await this.host.getSnapshot(conversationId);
    this.conversationId = conversationId;
    this.snapshot = snapshot;
    this.opened = true;
    return snapshot;
  }

  listSessions(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ConversationSessionPage> {
    if (this.host.listSessions === undefined) throw new Error("当前宿主不支持会话历史。");
    return this.host.listSessions({
      ...(this.workspaceRoot === undefined ? {} : { workspaceRoot: this.workspaceRoot }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  findSession(conversationId: string): Promise<ConversationSessionSummary | undefined> {
    return this.host.getSession?.(conversationId, this.workspaceRoot) ?? Promise.resolve(undefined);
  }

  async deleteSession(conversationId: string): Promise<ConversationSnapshot | undefined> {
    this.requireIdle("删除会话");
    if (this.host.deleteSession === undefined) throw new Error("当前宿主不支持会话历史。");
    await this.host.deleteSession(conversationId);
    if (conversationId !== this.conversationId) return undefined;
    return this.startNewConversation();
  }

  private requireIdle(action: string): void {
    if (this.closed) throw new Error("会话已关闭。");
    if (!this.opened) throw new Error("会话尚未打开。");
    if (this.activeRunId !== undefined || this.sending)
      throw new Error(`上一轮尚未结束，不能${action}。`);
  }

  async clear(): Promise<ConversationSnapshot> {
    if (this.closed) throw new Error("会话已关闭。");
    if (!this.opened) throw new Error("会话尚未打开。");
    if (this.activeRunId !== undefined || this.sending) throw new Error("上一轮尚未结束。");
    const snapshot = await this.host.clearConversation(this.conversationId);
    this.snapshot = snapshot;
    return snapshot;
  }

  async compact(
    options: ManualCompactionOptions = {},
  ): Promise<{ result: ManualCompactionResult; snapshot: ConversationSnapshot }> {
    if (this.closed) throw new Error("会话已关闭。");
    if (!this.opened) throw new Error("会话尚未打开。");
    if (this.activeRunId !== undefined || this.sending) throw new Error("上一轮尚未结束。");
    if (this.host.compactConversation === undefined) {
      throw new Error("当前宿主不支持手动压缩。");
    }
    this.sending = true;
    try {
      const result = await this.host.compactConversation(
        this.conversationId,
        this.accessToken,
        options,
      );
      this.snapshot = result.snapshot;
      return result;
    } finally {
      this.sending = false;
    }
  }

  /** 会话内切换模型；运行中的 run 保持原端点，拒绝切换而不是重建 run。 */
  setModel(model: ConversationModelConfig): void {
    if (this.closed) throw new Error("会话已关闭。");
    if (this.activeRunId !== undefined || this.sending) {
      throw new Error("当前运行中，不能切换模型。");
    }
    this.host.configure(model);
    this.model = model;
  }

  /** 更新下一次 send 使用的 API Key；活动 run 已发送的 token 不受影响。 */
  setAccessToken(accessToken: string): void {
    if (this.closed) throw new Error("会话已关闭。");
    this.accessToken = accessToken;
  }

  async send(text: string, images: readonly ImageAttachment[] = []): Promise<string> {
    if (this.closed) throw new Error("会话已关闭。");
    if (!this.opened) throw new Error("会话尚未打开。");
    if (this.activeRunId !== undefined || this.sending) throw new Error("上一轮尚未结束。");
    this.sending = true;
    try {
      const { runId } = await this.host.send(
        this.conversationId,
        { text, images: [...images] },
        this.accessToken,
      );
      this.activeRunId = runId;
      return runId;
    } finally {
      this.sending = false;
    }
  }

  /**
   * 交给 host 队列接受一条用户消息。已有活动 run 时 host 返回 queued，
   * 消息会在当前 step 结束后自动开始；不等待 run 开始。
   */
  async enqueue(
    text: string,
    images: readonly ImageAttachment[] = [],
  ): Promise<ConversationSendResult> {
    if (this.closed) throw new Error("会话已关闭。");
    if (!this.opened) throw new Error("会话尚未打开。");
    const request = { text, images: [...images] };
    const accepted = await this.host.enqueue(this.conversationId, request, this.accessToken);
    if (accepted.status === "started") this.activeRunId = accepted.runId;
    return accepted;
  }

  async waitForQueueStart(
    queueId: string,
  ): Promise<{ queueId: string; runId: string; snapshot: ConversationSnapshot }> {
    const started = await this.host.waitForQueueStart(this.conversationId, queueId);
    this.activeRunId = started.runId;
    return started;
  }

  async wait(runId: string): Promise<void> {
    try {
      await this.host.waitForRun(runId);
    } finally {
      if (this.activeRunId === runId) this.activeRunId = undefined;
    }
  }

  cancel(): boolean {
    const runId = this.activeRunId;
    if (runId === undefined) return false;
    this.cancelRun(runId);
    return true;
  }

  cancelRun(runId: string): void {
    this.host.cancel(runId);
    if (this.activeRunId === runId) this.activeRunId = undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }
}
