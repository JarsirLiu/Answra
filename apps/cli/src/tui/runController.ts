/** TUI 会话运行编排：每个会话独立 queue/busy/cancel，并把活动会话投影到 view store。 */
import type { ConversationModelConfig, ConversationSnapshot } from "@answra/shared";
import type { ImageAttachment } from "../image/attachment";
import type { CodingSession } from "../session/codingSession";
import type { TuiViewStore } from "./app/viewStore";
import type { TuiRuntime } from "./commands/access";

export type TuiSessionFactory = (
  model: ConversationModelConfig,
  accessToken?: string,
  conversationId?: string,
) => CodingSession;

interface QueuedTurn {
  readonly text: string;
  readonly images: readonly ImageAttachment[];
}

interface SessionRuntime {
  conversationId: string;
  readonly session: CodingSession;
  readonly queue: QueuedTurn[];
  busy: boolean;
  cancelRequested: boolean;
}

export interface TuiRunControllerOptions {
  readonly store: TuiViewStore;
  readonly createSession?: TuiSessionFactory;
  readonly resolveAccessToken: () => Promise<string | undefined>;
}

export class TuiRunController {
  private readonly store: TuiViewStore;
  private readonly createSession?: TuiSessionFactory;
  private readonly resolveAccessToken: () => Promise<string | undefined>;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private activeId?: string;

  constructor({ store, createSession, resolveAccessToken }: TuiRunControllerOptions) {
    this.store = store;
    this.createSession = createSession;
    this.resolveAccessToken = resolveAccessToken;
  }

  get activeSession(): CodingSession | undefined {
    return this.activeRuntime()?.session;
  }

  register(next: CodingSession): SessionRuntime {
    const existing = this.runtimes.get(next.currentConversationId);
    if (existing !== undefined) {
      this.activeId = existing.conversationId;
      return existing;
    }
    const runtime: SessionRuntime = {
      conversationId: next.currentConversationId,
      session: next,
      queue: [],
      busy: false,
      cancelRequested: false,
    };
    this.runtimes.set(runtime.conversationId, runtime);
    this.activeId = runtime.conversationId;
    return runtime;
  }

  runtime(): TuiRuntime {
    return {
      runActive: [...this.runtimes.values()].some((item) => item.busy),
      activeRunActive: this.activeRuntime()?.busy ?? false,
      compactionActive: this.store.getSnapshot().compactionActive,
    };
  }

  submit(text: string, images: readonly ImageAttachment[] = []): void {
    const runtime = this.activeRuntime();
    if (runtime === undefined) return;
    if (text.trim().length === 0 && images.length === 0) return;
    runtime.queue.push({ text, images });
    this.sync(runtime);
    void this.drain(runtime);
  }

  cancel(): boolean {
    const runtime = this.activeRuntime();
    if (runtime === undefined || !runtime.busy) return false;
    runtime.cancelRequested = true;
    runtime.queue.length = 0;
    this.sync(runtime);
    runtime.session.cancel();
    return true;
  }

  async activate(conversationId: string): Promise<void> {
    if (this.activeSession?.currentConversationId === conversationId) return;
    if (this.store.getSnapshot().compactionActive) {
      throw new Error("正在压缩上下文，先按 Esc 取消或等待完成后再恢复会话。");
    }
    const existing = this.runtimes.get(conversationId);
    if (existing !== undefined) {
      const snapshot = await existing.session.refresh();
      this.activeId = existing.conversationId;
      this.store.switchConversation(snapshot);
      this.sync(existing);
      return;
    }
    const current = this.activeSession;
    if (current === undefined) throw new Error("尚未配置模型。");
    if (this.createSession === undefined) throw new Error("当前 TUI 未提供会话工厂。");
    const token = await this.resolveAccessToken();
    const next = this.createSession(current.modelConfig, token, conversationId);
    const snapshot = await next.open();
    const runtime = this.register(next);
    this.store.switchConversation(snapshot);
    this.sync(runtime);
  }

  async createNew(): Promise<void> {
    const runtime = this.activeRuntime();
    if (runtime === undefined) throw new Error("尚未配置模型。");
    if (this.store.getSnapshot().compactionActive) {
      throw new Error("正在压缩上下文，先按 Esc 取消或等待完成后再新建会话。");
    }
    const previousId = runtime.session.currentConversationId;
    const snapshot = await runtime.session.startNewConversation();
    this.runtimes.delete(previousId);
    runtime.conversationId = snapshot.conversationId;
    this.runtimes.set(runtime.conversationId, runtime);
    this.activeId = runtime.conversationId;
    this.store.reset(snapshot);
    this.sync(runtime);
  }

  async delete(conversationId: string): Promise<ConversationSnapshot | undefined> {
    const target = this.runtimes.get(conversationId);
    if (target?.busy) {
      throw new Error(`会话 ${conversationId} 正在运行，先切回并按 Esc 中断或等待结束后再删除。`);
    }
    const active = this.activeRuntime();
    if (active === undefined) throw new Error("尚未配置模型。");
    if (active.busy) throw new Error("当前运行中，先按 Esc 中断或等待本轮结束后再删除会话。");
    const previousId = active.session.currentConversationId;
    const next = await active.session.deleteSession(conversationId);
    if (target !== undefined && target !== active) {
      target.session.close();
      this.runtimes.delete(conversationId);
    }
    if (target === active && next !== undefined) {
      this.runtimes.delete(previousId);
      active.conversationId = active.session.currentConversationId;
      this.runtimes.set(active.conversationId, active);
      this.activeId = active.conversationId;
    }
    return next;
  }

  private activeRuntime(): SessionRuntime | undefined {
    if (this.activeId === undefined) return undefined;
    return this.runtimes.get(this.activeId);
  }

  private sync(runtime: SessionRuntime): void {
    if (runtime !== this.activeRuntime()) return;
    this.store.setQueued(runtime.queue.length);
    if (runtime.busy) {
      if (runtime.cancelRequested) this.store.markCancelling();
      else this.store.beginRun();
      return;
    }
    this.store.finishRun();
  }

  private async drain(runtime: SessionRuntime): Promise<void> {
    if (runtime.busy) return;
    const turn = runtime.queue.shift();
    if (turn === undefined) {
      this.sync(runtime);
      return;
    }
    runtime.busy = true;
    runtime.cancelRequested = false;
    this.sync(runtime);
    let failed = false;
    try {
      const runId = await runtime.session.send(turn.text, turn.images);
      if (runtime.cancelRequested) runtime.session.cancel();
      await runtime.session.wait(runId);
    } catch (error) {
      failed = true;
      runtime.queue.length = 0;
      if (runtime === this.activeRuntime()) this.store.fail(messageOf(error));
      else {
        this.store.notify({
          key: `run-error:${runtime.conversationId}`,
          text: `后台会话 ${runtime.conversationId} 运行失败：${messageOf(error)}`,
          tone: "error",
        });
      }
    } finally {
      runtime.busy = false;
      runtime.cancelRequested = false;
    }
    if (!failed && runtime.queue.length > 0) {
      void this.drain(runtime);
      return;
    }
    this.sync(runtime);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
