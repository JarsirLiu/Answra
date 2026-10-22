/**
 * Candidate turn settle 合并层：把窗口内紧邻（VAD 静音闭合 + 强切上限内仍
 * 会分开）的 committed candidate turns 合并成一条用户消息，并对合并后仍然
 * 无内容的短轮（附和音、误触发）显式丢弃。
 * 它不改变 transcript/turn 的语义；只决定“什么时候、以什么粒度进入对话”。
 */
import {
  conversationId as asConversationId,
  type CommittedInterviewTurn,
  type ConversationId,
  type SessionId,
} from "../contracts";

export interface CandidateTurnSettlerOptions {
  /** 上一个 committed turn 之后等待紧邻续句的墙钟窗口；每收到新 turn 顺延。 */
  settleMs: number;
  /** 合并后短于该字符数的一轮视为附和音/无效轮，不进对话。 */
  minTurnChars: number;
}

export interface CandidateTurnSettlerSink {
  /** 窗口结算：同一会话待合并的 turns 与合并文本交给宿主（append + 事件投影）。 */
  onSettled(turns: readonly CommittedInterviewTurn[], text: string): void;
}

/** 初始值：覆盖 “VAD 500ms 静音闭合 + 整段 Paraformer 解码延迟” ;待真实面试样本校准。 */
export const DEFAULT_CANDIDATE_TURN_SETTLE_MS = 1_000;
/** 小于两个字（“嗯”“哦”“对”）不作为一轮用户消息进入对话。 */
export const MIN_CANDIDATE_TURN_CHARS = 2;

interface SettleEntry {
  sessionId: SessionId;
  conversationId: ConversationId;
  turns: CommittedInterviewTurn[];
}

export class CandidateTurnSettler {
  private readonly pending = new Map<SessionId, SettleEntry>();
  private readonly timers = new Map<SessionId, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly options: CandidateTurnSettlerOptions,
    private readonly sink: CandidateTurnSettlerSink,
  ) {}

  /** 窗口不足时不立即产出；窗口耗尽或下一条命令到来时按合并结果结算。 */
  receive(turn: CommittedInterviewTurn): void {
    const entry = this.pending.get(turn.sessionId) ?? {
      sessionId: turn.sessionId,
      conversationId: asConversationId(turn.conversationId),
      turns: [],
    };
    entry.turns.push(turn);
    this.pending.set(turn.sessionId, entry);
    this.scheduleFlush(entry.sessionId);
  }

  /** 停止会话时的显式结算：不等窗口，把已挂起的内容立刻交给宿主。 */
  flush(sessionId: SessionId): void {
    const entry = this.takeEntry(sessionId);
    if (!entry) return;
    this.settle(entry);
  }

  /** 会话失败/采集失效时的显式丢弃：只清挂起状态，不产生任何消息。 */
  discard(sessionId: SessionId): void {
    this.takeEntry(sessionId);
  }

  discardAll(): void {
    for (const sessionId of [...this.pending.keys()]) this.discard(sessionId);
  }

  private settle(entry: SettleEntry): void {
    const text = entry.turns
      .map((turn) =>
        [...turn.chunks]
          .sort((left, right) => left.chunkIndex - right.chunkIndex)
          .map((chunk) => chunk.text)
          .join(""),
      )
      .join("")
      .trim();
    // 短于阈值的内容不进对话，也不发出 committed 事件——被吞的“嗯”不该被下游消费。
    if (text.length < this.options.minTurnChars) return;
    this.sink.onSettled(entry.turns, text);
  }

  private scheduleFlush(sessionId: SessionId): void {
    const previous = this.timers.get(sessionId);
    if (previous) clearTimeout(previous);
    if (this.options.settleMs <= 0) {
      this.flush(sessionId);
      return;
    }
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        this.flush(sessionId);
      }, this.options.settleMs),
    );
  }

  private takeEntry(sessionId: SessionId): SettleEntry | undefined {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    const entry = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    return entry;
  }
}
