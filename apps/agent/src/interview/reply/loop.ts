/**
 * 面试语音的回复状态机：持有当前回复 run，负责开口取消与结算后启动回复。
 * 它不碰采集、VAD、ASR、模型或传输；这些只经端口注入。
 *
 * 当前只接入一个触发源（candidate）。第二个 source 进入时，必须先决定它是否
 * 允许打断、以及它的 turn 是否进入同一会话，再扩展这里。
 */
import type { AudioSource, CommittedInterviewTurn } from "../contracts";

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
  /** 只有这一路语音的开口会取消在途回复。 */
  source: AudioSource;
  ports: InterviewReplyPorts;
}

interface ActiveReply {
  readonly runId: string;
  readonly done: Promise<void>;
}

export class InterviewReplyLoop {
  private readonly ports: InterviewReplyPorts;
  private readonly source: AudioSource;
  private active?: ActiveReply;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  /** 每次会话 start/stop 递增；用于淘汰上一场会话尚未落账的结算。 */
  private sessionEpoch = 0;
  /** 每次触发源开口递增；用于淘汰开口前已开始、开口后才拿到的 runId 的回复。 */
  private speechEpoch = 0;

  constructor(options: InterviewReplyLoopOptions) {
    this.ports = options.ports;
    this.source = options.source;
  }

  /** 新会话开始；只有 host 的组合点调用。 */
  start(): void {
    this.stopped = false;
    this.sessionEpoch += 1;
  }

  /** 触发源开口：立即取消在途回复，不等待落账，也不阻塞音频链路。 */
  speechStarted(source: AudioSource): void {
    if (source !== this.source) return;
    // 即使当前还没有 active，也要推进 epoch：回复可能正在取令牌或落账，
    // 不能在开口之后再把上一轮的回复启动起来。
    this.speechEpoch += 1;
    if (this.stopped) return;
    const active = this.active;
    if (!active) return;
    // 保留 active 直到落账：下一次 turnSettled 必须先等它结束，才能认领新 run。
    this.ports.cancelReply(active.runId);
  }

  /** 一轮语音结算：user 消息落账，触发源随后启动回复。 */
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
    await this.queue.catch(() => undefined);
    await this.finishActive();
  }

  private async settle(
    conversationId: string,
    turns: readonly CommittedInterviewTurn[],
    text: string,
    sessionEpoch: number,
  ): Promise<void> {
    // 先记下本轮结算时的开口序号：等待旧 run 落账或追加用户消息期间若用户
    // 又开口，这一轮的回复就已经过期，不能再启动。
    const epoch = this.speechEpoch;
    await this.finishActive();
    try {
      await this.ports.appendUserTurn(conversationId, turns, text);
    } catch (error) {
      this.ports.onError("append", error);
      return;
    }
    // 停止或切换到新会话期间只保留用户消息，不再产生新的回复。
    if (this.stopped || sessionEpoch !== this.sessionEpoch || epoch !== this.speechEpoch) return;
    await this.startReply(conversationId, epoch, sessionEpoch);
  }

  private async startReply(
    conversationId: string,
    epoch: number,
    sessionEpoch: number,
  ): Promise<void> {
    try {
      const { runId } = await this.ports.startReply(conversationId);
      const active: ActiveReply = { runId, done: this.ports.waitForReply(runId) };
      this.active = active;
      // startReply 可能等待令牌；若期间用户已开口、会话已停止或已切换到新场次，
      // 立即取消这个迟到的 run。保留 active 让后续 turnSettled 等它落账，避免并发认领。
      if (this.stopped || sessionEpoch !== this.sessionEpoch || epoch !== this.speechEpoch)
        this.ports.cancelReply(runId);
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

  private async finishActive(): Promise<void> {
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
