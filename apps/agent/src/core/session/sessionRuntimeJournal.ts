/**
 * 把 journal append 串成唯一的写入顺序：先落 journal 事实，再广播同一事实的
 * `SessionFrame`，然后投影旧 wire 事件，最后写 transcript。transcript 失败不回滚已追加的事实。
 *
 * 新增消费者只订阅 frame；旧 projector 只服务尚未迁移的 wire。
 */
import type { AgentDurableEvent, SessionEventEnvelope } from "@answra/shared/schema";
import { toSessionFrame } from "@answra/shared/schema";
import type { SessionId } from "./contracts";
import { sessionId } from "./contracts";
import type { SessionJournal, SessionJournalAppend } from "./journal";
import type { SessionEventProjector } from "./sessionEventProjector";
import type { SessionFrameBus } from "./sessionFrameBus";
import type { SessionTranscriptBridge } from "./transcriptBridge";

export interface SessionRuntimeJournalOptions {
  journal: SessionJournal;
  /** durable 事实帧的进程内广播口；不保存历史，也不分配游标。 */
  frames: SessionFrameBus;
  /** 旧 wire 的兼容投影；P2 删除后只剩 journal → frames → transcript。 */
  projector: SessionEventProjector;
  bridge: SessionTranscriptBridge;
  /** Turn/Step/压缩边界后的快照推送；不参与事实写入。 */
  onBoundary?: (sessionId: SessionId) => void | Promise<void>;
  /** handoff 落库前的 Bot 发现 ACL 校验。 */
  authorizeHandoff?: (
    sessionId: SessionId,
    event: Extract<AgentDurableEvent, { type: "turn-handoff" }>,
  ) => Promise<void>;
  /**
   * durable 事实落库后的只读观察点（如 usage 锚点、上下文状态）。
   * 不改变写入顺序，也不产生新事实；实现方必须自行 fail-soft。
   */
  onDurableEvent?: (sessionId: SessionId, event: AgentDurableEvent) => void | Promise<void>;
}

export class SessionRuntimeJournal implements SessionJournal {
  private readonly journal: SessionJournal;
  private readonly frames: SessionFrameBus;
  private readonly projector: SessionEventProjector;
  private readonly bridge: SessionTranscriptBridge;
  private readonly onBoundary: SessionRuntimeJournalOptions["onBoundary"];
  private readonly authorizeHandoff: SessionRuntimeJournalOptions["authorizeHandoff"];
  private readonly onDurableEvent: SessionRuntimeJournalOptions["onDurableEvent"];

  constructor(options: SessionRuntimeJournalOptions) {
    this.journal = options.journal;
    this.frames = options.frames;
    this.projector = options.projector;
    this.bridge = options.bridge;
    this.onBoundary = options.onBoundary;
    this.authorizeHandoff = options.authorizeHandoff;
    this.onDurableEvent = options.onDurableEvent;
  }

  async append(
    sessionId: SessionId,
    event: AgentDurableEvent,
    metadata: SessionJournalAppend = {},
  ): Promise<SessionEventEnvelope> {
    if (event.type === "turn-handoff" && this.authorizeHandoff !== undefined) {
      await this.authorizeHandoff(sessionId, event);
    }
    const envelope = await this.journal.append(sessionId, event, metadata);
    this.frames.publish(toSessionFrame(envelope));
    await this.projector.apply(envelope);
    await this.bridge.apply(envelope, await this.projector.revision(sessionId));
    if (this.onDurableEvent !== undefined) await this.onDurableEvent(sessionId, event);
    if (this.onBoundary !== undefined && isBoundary(event.type)) await this.onBoundary(sessionId);
    return envelope;
  }

  readAfter(sessionId: SessionId, sequence: number): Promise<SessionEventEnvelope[]> {
    return this.journal.readAfter(sessionId, sequence);
  }

  lastSequence(sessionId: SessionId): Promise<number> {
    return this.journal.lastSequence(sessionId);
  }

  clear(sessionId: SessionId): Promise<void> {
    return this.journal.clear(sessionId);
  }

  /**
   * 压缩事实的唯一写入入口。
   *
   * 压缩器在 `core/context` 执行，但事实必须和 Turn/Step 走同一顺序：journal → UI 投影 →
   * transcript → onDurableEvent → 边界快照。`operationId` 负责把 started 与终态关联起来。
   */
  appendCompaction(fact: {
    conversationId: string;
    operationId: string;
    event: AgentDurableEvent;
  }): Promise<SessionEventEnvelope> {
    return this.append(sessionId(fact.conversationId), fact.event, {
      operationId: fact.operationId,
    });
  }
}

function isBoundary(type: AgentDurableEvent["type"]): boolean {
  switch (type) {
    case "turn-started":
    case "step-started":
    case "turn-handoff":
    case "turn-finished":
    case "compaction-started":
    case "compaction-finished":
    case "compaction-failed":
    case "compaction-aborted":
      return true;
    default:
      return false;
  }
}
