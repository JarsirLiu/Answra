/** 会话列表的 keyset 游标：对调用方不透明，只由存储层编码和解码。 */

export interface SessionCursor {
  updatedAt: string;
  conversationId: string;
}

const MAX_CURSOR_LENGTH = 512;

export function encodeSessionCursor(cursor: SessionCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      u: cursor.updatedAt,
      c: cursor.conversationId,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeSessionCursor(value: string): SessionCursor {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new Error("会话游标无效");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      typeof parsed.u !== "string" ||
      parsed.u.length === 0 ||
      typeof parsed.c !== "string" ||
      parsed.c.length === 0
    ) {
      throw new Error("会话游标无效");
    }
    return { updatedAt: parsed.u, conversationId: parsed.c };
  } catch (error) {
    if (error instanceof Error && error.message === "会话游标无效") throw error;
    throw new Error("会话游标无效");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
