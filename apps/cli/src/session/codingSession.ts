/** CLI coding 的单 Bot 会话用例：打开、发送、等待与取消；不涉及 TUI 或进程 I/O。 */
import type {
  ConversationModelConfig,
  ConversationSendRequest,
  ConversationSnapshot,
} from "@answra/shared";

/** 会话用例所需的最小宿主端口；由 adapters 映射到 @answra/agent/composition。 */
export interface CodingSessionHost {
  configure(model: ConversationModelConfig): void;
  createConversation(conversationId: string): Promise<ConversationSnapshot>;
  send(
    conversationId: string,
    request: ConversationSendRequest,
    accessToken: string,
  ): Promise<{ runId: string }>;
  cancel(runId: string): void;
  waitForRun(runId: string): Promise<void>;
  dispose(): void;
}

export interface CodingSessionOptions {
  host: CodingSessionHost;
  conversationId: string;
  model: ConversationModelConfig;
  accessToken: string;
}

/** 单活动 run 状态机；并发发送在进入 Agent 之前即被拒绝。 */
export class CodingSession {
  private readonly host: CodingSessionHost;
  private readonly conversationId: string;
  private readonly model: ConversationModelConfig;
  private readonly accessToken: string;
  private opened = false;
  private closed = false;
  private sending = false;
  private activeRunId?: string;

  constructor({ host, conversationId, model, accessToken }: CodingSessionOptions) {
    this.host = host;
    this.conversationId = conversationId;
    this.model = model;
    this.accessToken = accessToken;
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error("会话已关闭。");
    if (this.opened) return;
    this.host.configure(this.model);
    await this.host.createConversation(this.conversationId);
    this.opened = true;
  }

  async send(text: string): Promise<string> {
    if (this.closed) throw new Error("会话已关闭。");
    if (!this.opened) throw new Error("会话尚未打开。");
    if (this.activeRunId !== undefined || this.sending) throw new Error("上一轮尚未结束。");
    this.sending = true;
    try {
      const { runId } = await this.host.send(
        this.conversationId,
        { text, images: [] },
        this.accessToken,
      );
      this.activeRunId = runId;
      return runId;
    } finally {
      this.sending = false;
    }
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
    this.host.cancel(runId);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.host.dispose();
  }
}
