import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

export function conversationFilePath(root: string, conversationId: string): string {
  if (!isConversationId(conversationId)) throw new Error("会话 ID 无效");
  const base = resolve(root);
  const filePath = resolve(base, `${conversationId}.json`);
  if (!filePath.startsWith(`${base}${sep}`)) throw new Error("会话路径无效");
  return filePath;
}

export async function ensureSessionRoot(root: string): Promise<string> {
  const base = resolve(root);
  await mkdir(base, { recursive: true });
  return base;
}

export function sessionRootPath(root: string): string {
  return resolve(root);
}

export function corruptFilePath(filePath: string): string {
  return `${filePath}.corrupt-${Date.now()}`;
}

export function isSessionFileName(name: string): boolean {
  return name.endsWith(".json") && isConversationId(name.slice(0, -5));
}

export function sessionFilePathForList(root: string, name: string): string {
  return join(resolve(root), name);
}
