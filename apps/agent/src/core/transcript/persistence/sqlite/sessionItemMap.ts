/** `session_items` 行与 `SessionItem` 的纯映射；不执行 SQL、不判断 Turn 语义。 */
import {
  type SessionItem,
  sessionItemPayloadSchema,
  sessionItemSchema,
} from "@answra/shared/schema";

/** 数据库列名到值的形状；`kind` 单独成列以支持 CHECK 与索引，读取时与 payload 校验。 */
export interface SessionItemColumns {
  seq: number;
  item_id: string;
  kind: string;
  status: string;
  turn_id: string | null;
  message_id: string | null;
  author_agent_id: string | null;
  audience_agent_id: string | null;
  created_at: string;
  payload_json: string;
}

/** 写入前过一遍 schema：`session_items` 不可 UPDATE，错一行就是永久错。 */
export function toSessionItemColumns(item: SessionItem): SessionItemColumns {
  const parsed = sessionItemSchema.parse(item);
  return {
    seq: parsed.seq,
    item_id: parsed.itemId,
    kind: parsed.payload.kind,
    status: parsed.status,
    turn_id: parsed.turnId ?? null,
    message_id: parsed.messageId ?? null,
    author_agent_id: parsed.authorAgentId ?? null,
    audience_agent_id: parsed.audienceAgentId ?? null,
    created_at: parsed.createdAt,
    payload_json: JSON.stringify(parsed.payload),
  };
}

export function fromSessionItemColumns(row: SessionItemColumns): SessionItem {
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json) as unknown;
  } catch (error) {
    throw new Error(
      `条目 payload 无法解析：${row.item_id}（${
        error instanceof Error ? error.message : String(error)
      }）`,
    );
  }
  const payload = sessionItemPayloadSchema.parse(value);
  if (payload.kind !== row.kind) {
    throw new Error(`条目 kind 与 payload 不一致：${row.item_id}（${row.kind} / ${payload.kind}）`);
  }
  return sessionItemSchema.parse({
    seq: row.seq,
    itemId: row.item_id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    ...(row.author_agent_id === null ? {} : { authorAgentId: row.author_agent_id }),
    ...(row.audience_agent_id === null ? {} : { audienceAgentId: row.audience_agent_id }),
    payload,
  });
}
