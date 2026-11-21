/** TUI 会话运行编排：每会话复用 host 队列，活动会话投影到 view store。 */
import type { ConversationModelConfig, ConversationSnapshot } from "@answra/shared";
import type { ImageAttachment } from "../image/attachment";
import type { CodingSession } from "../session/codingSession";
import type { TuiViewStore } from "./app/viewStore";
import type { TuiRuntime } from "./commands/access";
import { SessionRunQueue } from "./sessionRunQueue";

export type TuiSessionFactory = (
  model: ConversationModelConfig,
  accessToken?: string,
  conversationId?: string,
) => CodingSession;

interface SessionRuntime {
  conversationId: string;
  readonly session: CodingSession;
  readonly runs: SessionRunQueue;
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
    let runtime: SessionRuntime;
    const runs = new SessionRunQueue({
      session: next,
      onChange: () => this.sync(runtime),
      onFailure: (error) => this.reportFailure(runtime, error),
    });
    runtime = {
      conversationId: next.currentConversationId,
      session: next,
      runs,
    };
    this.runtimes.set(runtime.conversationId, runtime);
    this.activeId = runtime.conversationId;
    return runtime;
  }

  runtime(): TuiRuntime {
    const active = this.activeRuntime();
    return {
      runActive: [...this.runtimes.values()].some((item) => item.runs.busy),
      activeRunActive: active?.runs.busy ?? false,
      compactionActive: this.store.getSnapshot().compactionActive,
    };
  }

  submit(text: string, images: readonly ImageAttachment[] = []): void {
    this.activeRuntime()?.runs.submit(text, images);
  }

  cancel(): boolean {
    return this.activeRuntime()?.runs.cancel() ?? false;
  }

  async activate(conversationId: string): Promise<void> {
    if (this.activeSession?.currentConversationId === conversationId) return;
    if (this.store.getSnapshot().compactionActive) {
      throw new Error("正在压缩上下文，等压缩完成后再切换会话。");
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
    if (this.createSession === undefined) throw new Error("当前 TUI 未提供会话创建器");
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
      throw new Error("正在压缩上下文，等压缩完成后再新建会话。");
    }
    if (runtime.runs.busy) throw new Error("当前会话仍有运行或排队消息，结束后再新建。");
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
    if (target?.runs.busy) {
      throw new Error(`会话 ${conversationId} 正在运行或排队，先切换回会话执行 Esc 中断。`);
    }
    const active = this.activeRuntime();
    if (active === undefined) throw new Error("尚未配置模型。");
    if (active.runs.busy) {
      throw new Error("当前会话正在运行或排队，先执行 Esc 中断再删除会话。");
    }
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
    this.store.setQueuedPrompts(runtime.runs.prompts);
    if (runtime.runs.busy) {
      if (runtime.runs.cancellingRun) this.store.markCancelling();
      else this.store.beginRun();
      return;
    }
    this.store.finishRun();
  }

  private reportFailure(runtime: SessionRuntime, error: unknown): void {
    if (runtime === this.activeRuntime()) this.store.fail(messageOf(error));
    else {
      this.store.notify({
        key: `run-error:${runtime.conversationId}`,
        text: `后台会话 ${runtime.conversationId} 发送失败：${messageOf(error)}`,
        tone: "error",
      });
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
