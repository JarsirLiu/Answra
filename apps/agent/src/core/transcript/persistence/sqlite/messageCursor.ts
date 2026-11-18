/** 会话消息 keyset 游标：对调用方不透明，只由 SQLite 存储层编码和解码。 */
const MAX_MESSAGE_CURSOR_LENGTH = 512;

export interface MessageCursor {
  conversationId: string;
  seq: number;
}

export function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      c: cursor.conversationId,
      s: cursor.seq,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeMessageCursor(value: string): MessageCursor {
  if (value.length === 0 || value.length > MAX_MESSAGE_CURSOR_LENGTH) {
    throw new Error("消息游标无效");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      typeof parsed.c !== "string" ||
      parsed.c.length === 0 ||
      typeof parsed.s !== "number" ||
      !Number.isInteger(parsed.s) ||
      parsed.s <= 0
    ) {
      throw new Error("消息游标无效");
    }
    return { conversationId: parsed.c, seq: parsed.s };
  } catch (error) {
    if (error instanceof Error && error.message === "消息游标无效") throw error;
    throw new Error("消息游标无效");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
