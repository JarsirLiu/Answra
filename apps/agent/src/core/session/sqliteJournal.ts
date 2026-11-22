/** SQLite SessionJournal 适配器：在 sessions.sqlite 中按会话追加事件，不读写 transcript 表。 */
import type { DatabaseSync } from "node:sqlite";
import {
  type AgentDurableEvent,
  type SessionEventEnvelope,
  sessionEventEnvelopeSchema,
} from "@answra/shared/schema";
import { openSessionDatabase } from "../transcript/persistence/sqlite/sqliteDatabase";
import { withImmediateTransaction } from "../transcript/persistence/sqlite/transaction";
import type { SessionId } from "./contracts";
import { createSessionEvent } from "./eventFactory";
import type { SessionJournal, SessionJournalAppend } from "./journal";
import { applySessionTurnProjection } from "./sessionTurnProjection";

const NEXT_SEQUENCE_SQL = `
  SELECT COALESCE(MAX(seq), 0) + 1 AS next_sequence
  FROM session_events
  WHERE conversation_id = ?
`;

const INSERT_EVENT_SQL = `
  INSERT INTO session_events
    (conversation_id, seq, event_id, turn_id, message_id, step_id, operation_id,
     producer_id, occurred_at, event_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const READ_AFTER_SQL = `
  SELECT seq, event_json
  FROM session_events
  WHERE conversation_id = ? AND seq > ?
  ORDER BY seq ASC
`;

const LAST_SEQUENCE_SQL = `
  SELECT COALESCE(MAX(seq), 0) AS last_sequence
  FROM session_events
  WHERE conversation_id = ?
`;

const CLEAR_SQL = `
  DELETE FROM session_events
  WHERE conversation_id = ?
`;

interface SequenceRow {
  next_sequence: number;
}

interface LastSequenceRow {
  last_sequence: number;
}

interface StoredEventRow {
  seq: number;
  event_json: string;
}

/** 每个实例持有自己的 SQLite 连接；同一文件由 WAL 与 busy_timeout 串行化写入。 */
export class SqliteSessionJournal implements SessionJournal {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(root: string) {
    this.db = openSessionDatabase(root);
  }

  async append(
    sessionId: SessionId,
    event: AgentDurableEvent,
    metadata: SessionJournalAppend = {},
  ): Promise<SessionEventEnvelope> {
    this.assertOpen();
    return withImmediateTransaction(this.db, () => {
      const sequence = this.nextSequence(sessionId);
      const envelope = createSessionEvent({ sessionId, sequence, ...metadata }, event);
      this.db
        .prepare(INSERT_EVENT_SQL)
        .run(
          sessionId,
          envelope.sequence,
          envelope.eventId,
          envelope.turnId ?? null,
          envelope.messageId ?? null,
          envelope.stepId ?? null,
          envelope.operationId ?? null,
          envelope.producerId,
          envelope.occurredAt,
          JSON.stringify(envelope),
        );
      applySessionTurnProjection(this.db, envelope);
      return envelope;
    });
  }

  async readAfter(sessionId: SessionId, sequence: number): Promise<SessionEventEnvelope[]> {
    this.assertOpen();
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error("Session event sequence 必须是非负整数");
    }
    const rows = this.db
      .prepare(READ_AFTER_SQL)
      .all(sessionId, sequence) as unknown as StoredEventRow[];
    return rows.map((row) => parseEnvelope(sessionId, row));
  }

  async lastSequence(sessionId: SessionId): Promise<number> {
    this.assertOpen();
    const row = this.db.prepare(LAST_SEQUENCE_SQL).get(sessionId) as LastSequenceRow | undefined;
    if (row === undefined) throw new Error(`无法读取 Session event sequence：${sessionId}`);
    return row.last_sequence;
  }

  async clear(sessionId: SessionId): Promise<void> {
    this.assertOpen();
    withImmediateTransaction(this.db, () => {
      this.db.prepare(CLEAR_SQL).run(sessionId);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private nextSequence(sessionId: SessionId): number {
    const row = this.db.prepare(NEXT_SEQUENCE_SQL).get(sessionId) as SequenceRow | undefined;
    if (row === undefined) throw new Error(`无法读取 Session event sequence：${sessionId}`);
    return row.next_sequence;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Session journal 已关闭");
  }
}

function parseEnvelope(sessionId: SessionId, row: StoredEventRow): SessionEventEnvelope {
  const parsed = sessionEventEnvelopeSchema.safeParse(JSON.parse(row.event_json) as unknown);
  if (!parsed.success) {
    // HEAD 版本曾把 live-only 增量写进 session_events；这些行不是合法事实，也不能靠“读时跳过”
    // 兼容——跳过会让 sequence 出现空洞，投影的连续性校验会直接拒绝整个会话。
    if (legacyLiveOnlyType(row.event_json) !== undefined) {
      throw new Error(
        `Session journal 含已废弃的实时增量事件（${sessionId} / ${row.seq}）：` +
          "请重置本地数据库（pnpm db:reset --yes）后重新运行。",
      );
    }
    throw new Error(
      `Session journal 事件无法解析：${sessionId} / ${row.seq} / ${parsed.error.message}`,
    );
  }
  const envelope = parsed.data;
  if (envelope.sessionId !== sessionId || envelope.sequence !== row.seq) {
    throw new Error(`Session journal 事件与行不匹配：${sessionId} / ${row.seq}`);
  }
  return envelope;
}

/** 只认已知 live-only 类型：其他解析失败仍按损坏数据报错。 */
const LEGACY_LIVE_ONLY_TYPES = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-delta",
  "tool-output-delta",
]);

function legacyLiveOnlyType(eventJson: string): string | undefined {
  try {
    const raw = JSON.parse(eventJson) as { event?: { type?: unknown } } | null;
    const type = raw?.event?.type;
    return typeof type === "string" && LEGACY_LIVE_ONLY_TYPES.has(type) ? type : undefined;
  } catch {
    return undefined;
  }
}
