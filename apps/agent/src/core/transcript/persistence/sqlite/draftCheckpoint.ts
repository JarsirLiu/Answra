/** 活动 assistant 消息的草稿 checkpoint 调度；只管定时与边界，不执行 SQL。 */
import type { AgentEventEnvelope } from "@answra/shared/schema";

const STREAM_CHECKPOINT_INTERVAL_MS = 1_000;
const STREAM_CHECKPOINT_MIN_CHARS = 2_048;

interface CheckpointState {
  messageId: string;
  pendingChars: number;
  lastFlushedAt: number;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface DraftCheckpointSchedulerOptions {
  /** 消息仍属于活动 run 的 streaming assistant 时才允许写入。 */
  isTarget: (conversationId: string, messageId: string) => boolean;
  /** 由 store 负责读取当前内存消息并执行草稿事务。 */
  write: (conversationId: string, messageId: string) => Promise<void>;
  now?: () => number;
}

export class DraftCheckpointScheduler {
  private readonly checkpoints = new Map<string, CheckpointState>();
  private readonly now: () => number;

  constructor(private readonly options: DraftCheckpointSchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  schedule(conversationId: string, envelope: AgentEventEnvelope): void {
    const messageId = envelope.runId;
    if (!this.options.isTarget(conversationId, messageId)) return;
    const added = checkpointChars(envelope.event);
    const boundary = isCheckpointBoundary(envelope.event);
    if (added === 0 && !boundary) return;
    let checkpoint = this.checkpoints.get(conversationId);
    if (!checkpoint || checkpoint.messageId !== messageId) {
      this.cancel(conversationId);
      checkpoint = {
        messageId,
        pendingChars: 0,
        lastFlushedAt: this.now(),
        dirty: false,
      };
      this.checkpoints.set(conversationId, checkpoint);
    }
    if (added > 0) {
      checkpoint.pendingChars += added;
      checkpoint.dirty = true;
    }
    if (!checkpoint.dirty) return;
    const elapsed = this.now() - checkpoint.lastFlushedAt;
    if (
      boundary ||
      checkpoint.pendingChars >= STREAM_CHECKPOINT_MIN_CHARS ||
      elapsed >= STREAM_CHECKPOINT_INTERVAL_MS
    ) {
      this.flushSoon(conversationId, checkpoint);
      return;
    }
    if (checkpoint.timer === undefined) {
      checkpoint.timer = setTimeout(
        () => {
          const current = this.checkpoints.get(conversationId);
          if (current === checkpoint && current.dirty) this.flushSoon(conversationId, current);
        },
        Math.max(0, STREAM_CHECKPOINT_INTERVAL_MS - elapsed),
      );
    }
  }

  cancel(conversationId: string): void {
    const checkpoint = this.checkpoints.get(conversationId);
    if (!checkpoint) return;
    if (checkpoint.timer !== undefined) clearTimeout(checkpoint.timer);
    this.checkpoints.delete(conversationId);
  }

  async close(): Promise<void> {
    const flushes: Promise<void>[] = [];
    for (const [conversationId, checkpoint] of [...this.checkpoints]) {
      if (checkpoint.timer !== undefined) clearTimeout(checkpoint.timer);
      if (checkpoint.dirty) flushes.push(this.flush(conversationId, checkpoint.messageId));
      this.checkpoints.delete(conversationId);
    }
    await Promise.allSettled(flushes);
  }

  private flushSoon(conversationId: string, checkpoint: CheckpointState): void {
    if (checkpoint.timer !== undefined) {
      clearTimeout(checkpoint.timer);
      checkpoint.timer = undefined;
    }
    void this.flush(conversationId, checkpoint.messageId);
  }

  private async flush(conversationId: string, messageId: string): Promise<void> {
    const checkpoint = this.checkpoints.get(conversationId);
    if (!checkpoint || checkpoint.messageId !== messageId) return;
    this.checkpoints.delete(conversationId);
    try {
      await this.options.write(conversationId, messageId);
    } catch (error) {
      console.warn("[transcript][checkpoint] 草稿写入失败，保留内存脏标记", error);
      this.checkpoints.set(conversationId, { ...checkpoint, timer: undefined, dirty: true });
    }
  }
}

function checkpointChars(event: AgentEventEnvelope["event"]): number {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta":
    case "tool-input-delta":
    case "tool-output-delta":
      return event.delta.length;
    default:
      return 0;
  }
}

function isCheckpointBoundary(event: AgentEventEnvelope["event"]): boolean {
  switch (event.type) {
    case "text-end":
    case "reasoning-end":
    case "tool-input-end":
    case "tool-call":
    case "tool-approval-request":
    case "tool-execution-finished":
    case "tool-result":
    case "tool-error":
    case "tool-output-denied":
    case "step-finished":
    case "error":
      return true;
    default:
      return false;
  }
}
