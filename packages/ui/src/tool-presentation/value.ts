/** Narrow guards and path helpers for unknown tool payloads. */
import { clipDetailText, TOOL_JSON_MAX_CHARS } from "./limits";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === value.length ? strings : undefined;
}

export function safeJson(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? undefined : serialized;
  } catch {
    return undefined;
  }
}

/** Safe, bounded text for fallback details; never throws on circular payloads. */
export function formatToolValue(value: unknown): string {
  if (typeof value === "string") return clipDetailText(value).text;
  const serialized = safeJson(value);
  if (serialized !== undefined) {
    return clipDetailText(serialized.slice(0, TOOL_JSON_MAX_CHARS)).text;
  }
  return String(value);
}

export function fileName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function directoryName(path: string): string | undefined {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return undefined;
  return normalized.slice(0, index);
}

export function firstLine(value: string): string {
  const line = value.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return (line ?? value).trim();
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}
