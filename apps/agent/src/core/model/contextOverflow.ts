/** 识别 provider 的上下文超限错误；只用于压缩兜底，不把供应商错误原文透传给产品层。 */
import { summarizeModelError } from "./errorSummary";

type ModelErrorSummary = ReturnType<typeof summarizeModelError>;

const OVERFLOW_PATTERNS = [
  "context_length_exceeded",
  "maximum context length",
  "context length exceeded",
  "prompt is too long",
  "prompt too long",
  "input is too long",
  "request is too large",
  "request too large",
  "too many tokens",
  "exceeds the context window",
  "exceeded the context window",
  "context window exceeded",
  "maximum number of tokens",
  "token limit exceeded",
];

/** 413 直接视为超限；400/422 等错误必须命中已知上下文超限文案。 */
export function isContextOverflowError(error: unknown): boolean {
  const summary = summarizeModelError(error);
  return hasOverflowStatus(summary) || hasOverflowText(summary);
}

function hasOverflowStatus(summary: ModelErrorSummary): boolean {
  if (summary.statusCode === 413) return true;
  if (summary.lastError && hasOverflowStatus(summary.lastError)) return true;
  return summary.attempts?.some((attempt) => hasOverflowStatus(attempt)) ?? false;
}

function hasOverflowText(summary: ModelErrorSummary): boolean {
  const text = [summary.error, summary.responseBody, summary.retryReason]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  if (OVERFLOW_PATTERNS.some((pattern) => text.includes(pattern))) return true;
  if (summary.lastError && hasOverflowText(summary.lastError)) return true;
  return summary.attempts?.some((attempt) => hasOverflowText(attempt)) ?? false;
}
