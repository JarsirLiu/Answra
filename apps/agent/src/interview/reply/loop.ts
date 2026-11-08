/**
 * 面试语音的回复状态机：持有当前回复 run，负责结算后启动回复。
 * 它不碰采集、VAD、ASR、模型或传输；这些只经端口注入。
 *
 * 语音开口只进入 ASR 链路；确认的 turn 才会通过端口中断当前回复，
 * 写入 transcript 并启动下一次回复。
 */
import type { CommittedInterviewTurn } from "../contracts";

export interface InterviewReplyPorts {
  /** 先把已结算的语音轮写成 user 消息，再交给事件投影。 */
  appendUserTurn(
    conversationId: string,
    turns: readonly CommittedInterviewTurn[],
    text: string,
  ): Promise<void>;
  /** 回复最后一条 user 消息；返回 run 身份。 */
  startReply(conversationId: string): Promise<{ runId: string }>;
  cancelReply(runId: string): void;
  /** run 落账完成信号，成功与 interrupted 都必须 resolve。 */
  waitForReply(runId: string): Promise<void>;
  onError(stage: "append" | "reply", error: unknown): void;
}

export interface InterviewReplyLoopOptions {
  ports: InterviewReplyPorts;
}

interface ActiveReply {
  readonly runId: string;
  readonly done: Promise<void>;
}

export class InterviewReplyLoop {
  private readonly ports: InterviewReplyPorts;
  private active?: ActiveReply;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  /** 每次会话 start/stop 递增；用于淘汰上一场会话尚未落账的结算。 */
  private sessionEpoch = 0;
  constructor(options: InterviewReplyLoopOptions) {
    this.ports = options.ports;
  }

  /** 新会话开始；只有 host 的组合点调用。 */
  start(): void {
    this.stopped = false;
    this.sessionEpoch += 1;
  }

  /** 一轮语音结算：确认后排队写入 user 消息，再启动回复。 */
  turnSettled(
    conversationId: string,
    turns: readonly CommittedInterviewTurn[],
    text: string,
  ): Promise<void> {
    const sessionEpoch = this.sessionEpoch;
    const task = this.queue.then(() => this.settle(conversationId, turns, text, sessionEpoch));
    // 队列本身必须继续接收后续轮次；错误已经经 onError 报出。
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** 停止会话：取消在途回复，但让已排队的 turn 仍然落账。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.sessionEpoch += 1;
    await this.cancelActive();
    await this.queue.catch(() => undefined);
  }

  private async settle(
    conversationId: string,
    turns: readonly CommittedInterviewTurn[],
    text: string,
    sessionEpoch: number,
  ): Promise<void> {
    await this.interruptActive();
    try {
      await this.ports.appendUserTurn(conversationId, turns, text);
    } catch (error) {
      this.ports.onError("append", error);
      return;
    }
    // 停止或切换到新会话期间只保留用户消息，不再产生新的回复。
    if (this.stopped || sessionEpoch !== this.sessionEpoch) return;
    await this.startReply(conversationId, sessionEpoch);
  }

  private async startReply(conversationId: string, sessionEpoch: number): Promise<void> {
    try {
      const { runId } = await this.ports.startReply(conversationId);
      const active: ActiveReply = { runId, done: this.ports.waitForReply(runId) };
      this.active = active;
      // startReply 可能等待令牌；会话停止或切换期间得到的迟到 run 仍需取消。
      if (this.stopped || sessionEpoch !== this.sessionEpoch) this.ports.cancelReply(runId);
      void active.done
        .then(() => {
          if (this.active === active) this.active = undefined;
        })
        .catch((error: unknown) => {
          if (this.active === active) this.active = undefined;
          this.ports.onError("reply", error);
        });
    } catch (error) {
      this.ports.onError("reply", error);
    }
  }

  private async interruptActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.ports.cancelReply(active.runId);
    try {
      await active.done;
    } catch (error) {
      this.ports.onError("reply", error);
    }
  }

  private async cancelActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.ports.cancelReply(active.runId);
    try {
      await active.done;
    } catch (error) {
      this.ports.onError("reply", error);
    }
  }
}
