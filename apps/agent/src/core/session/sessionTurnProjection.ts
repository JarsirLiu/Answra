/** session_turns 的 SQLite 投影写回：只由 journal append 调用，不推导业务状态。 */
import type { DatabaseSync } from "node:sqlite";
import type { SessionEventEnvelope, TurnOutcome } from "@answra/shared/schema";

const NEXT_TURN_SEQ_SQL = `
  SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
  FROM session_turns
  WHERE conversation_id = ?
`;

const INSERT_QUEUED_SQL = `
  INSERT INTO session_turns
    (conversation_id, turn_id, seq, source, status, entry_agent_id, active_agent_id,
     input_message_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
`;

const UPDATE_STARTED_SQL = `
  UPDATE session_turns
  SET status = 'running', active_agent_id = ?, updated_at = ?
  WHERE conversation_id = ? AND turn_id = ?
`;

const UPDATE_HANDOFF_SQL = `
  UPDATE session_turns
  SET active_agent_id = ?, updated_at = ?
  WHERE conversation_id = ? AND turn_id = ?
`;

const UPDATE_FINISHED_SQL = `
  UPDATE session_turns
  SET status = ?, finish_reason = ?, updated_at = ?
  WHERE conversation_id = ? AND turn_id = ?
`;

interface NextTurnSeqRow {
  next_seq: number;
}

/** 只处理 turn-*；step/模型流事件不改变 Turn 投影。 */
export function applySessionTurnProjection(db: DatabaseSync, envelope: SessionEventEnvelope): void {
  const event = envelope.event;
  switch (event.type) {
    case "turn-queued":
      insertQueuedTurn(db, envelope);
      return;
    case "turn-started":
      updateTurn(db, envelope, UPDATE_STARTED_SQL, event.agentId, envelope.occurredAt);
      return;
    case "turn-handoff":
      updateTurn(db, envelope, UPDATE_HANDOFF_SQL, event.toAgentId, envelope.occurredAt);
      return;
    case "turn-finished":
      updateTurn(
        db,
        envelope,
        UPDATE_FINISHED_SQL,
        event.status,
        event.reason ?? fallbackFinishReason(event.status),
        envelope.occurredAt,
      );
      return;
    default:
      return;
  }
}

function insertQueuedTurn(db: DatabaseSync, envelope: SessionEventEnvelope): void {
  const event = envelope.event;
  if (event.type !== "turn-queued") return;
  const currentTurnId = requireTurnId(envelope);
  const row = db.prepare(NEXT_TURN_SEQ_SQL).get(envelope.sessionId) as NextTurnSeqRow | undefined;
  if (row === undefined) throw new Error(`无法读取 Turn 投影 sequence：${envelope.sessionId}`);
  db.prepare(INSERT_QUEUED_SQL).run(
    envelope.sessionId,
    currentTurnId,
    row.next_seq,
    event.source,
    event.agentId,
    event.agentId,
    event.input?.id ?? null,
    envelope.occurredAt,
    envelope.occurredAt,
  );
}

function updateTurn(
  db: DatabaseSync,
  envelope: SessionEventEnvelope,
  sql: string,
  ...parameters: Array<string | null>
): void {
  const currentTurnId = requireTurnId(envelope);
  const result = db.prepare(sql).run(...parameters, envelope.sessionId, currentTurnId);
  if (Number(result.changes) !== 1) {
    throw new Error(`Turn 投影不存在：${envelope.sessionId} / ${currentTurnId}`);
  }
}

function requireTurnId(envelope: SessionEventEnvelope): string {
  if (envelope.turnId === undefined) {
    throw new Error(`${envelope.event.type} 缺少 turnId`);
  }
  return envelope.turnId;
}

function fallbackFinishReason(outcome: TurnOutcome): "completed" | "cancelled" | "unknown" {
  if (outcome === "completed") return "completed";
  if (outcome === "aborted") return "cancelled";
  return "unknown";
}
