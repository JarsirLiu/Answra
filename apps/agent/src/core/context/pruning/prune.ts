/** 旧工具结果清理：只替换最终模型投影中的白名单 tool-result 文本。 */
import type { ModelMessage, ToolResultPart } from "ai";
import type { ContextModelRequest } from "../budget";
import { estimateContextRequestTokens } from "../tokenEstimate";
import { PRUNED_TOOL_RESULT_TEXT } from "./clearedResult";
import type { ToolResultPruningPolicy } from "./policy";

export { PRUNED_TOOL_RESULT_TEXT };

/** 清理水印的容量上限；超出后丢弃最旧的 ID，未命中的结果最多再清一次。 */
export const PRUNED_TOOL_CALL_ID_LIMIT = 2_000;

export interface ToolResultPruningResult {
  readonly request: ContextModelRequest;
  readonly prunedCount: number;
  /** 本次实际替换的 toolCallId，供调用方合并到跨轮清理水印。 */
  readonly prunedToolCallIds: readonly string[];
  readonly savedTokens: number;
}

export interface AppliedToolResultPruning {
  readonly request: ContextModelRequest;
  /** 本次实际替换的 tool-result 数；未命中或已是占位符时不计入。 */
  readonly appliedCount: number;
}

interface PruningCandidate {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly toolCallId: string;
}

/** 跨轮水印：把已清理的 toolCallId 重新应用到新的模型投影。 */
export function applyPrunedToolResults({
  request,
  toolCallIds,
}: {
  request: ContextModelRequest;
  toolCallIds: readonly string[];
}): AppliedToolResultPruning {
  if (toolCallIds.length === 0) return { request, appliedCount: 0 };
  const targets = new Set(toolCallIds);
  let messages = request.messages;
  let appliedCount = 0;
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role !== "tool") continue;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      if (!targets.has(part.toolCallId)) return part;
      if (part.output.type !== "text") return part;
      if (part.output.value === PRUNED_TOOL_RESULT_TEXT) return part;
      changed = true;
      appliedCount += 1;
      return { ...part, output: { type: "text" as const, value: PRUNED_TOOL_RESULT_TEXT } };
    });
    if (changed) {
      const next = messages.slice();
      next[messageIndex] = { ...message, content };
      messages = next;
    }
  }
  return appliedCount === 0
    ? { request, appliedCount }
    : { request: { ...request, messages }, appliedCount };
}

/** 按清理顺序合并水印，去重并保留最新的上限条数。 */
export function mergePrunedToolCallIds({
  existing,
  added,
  limit = PRUNED_TOOL_CALL_ID_LIMIT,
}: {
  existing: readonly string[];
  added: readonly string[];
  limit?: number;
}): readonly string[] {
  if (added.length === 0) return existing;
  const merged = [...existing];
  const seen = new Set(existing);
  for (const id of added) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged.length <= limit ? merged : merged.slice(merged.length - limit);
}

/** 按旧到新替换可清理工具结果，直到达到目标 token 或候选耗尽。 */
export function pruneOldToolResults({
  request,
  targetTokens,
  policy,
  estimateTokens = estimateContextRequestTokens,
}: {
  request: ContextModelRequest;
  targetTokens: number;
  policy: ToolResultPruningPolicy;
  /** 可选估算器；调用方用它把 usage 锚点校准应用到候选选择和节省量。 */
  estimateTokens?: (request: ContextModelRequest) => number;
}): ToolResultPruningResult {
  const beforeTokens = estimateTokens(request);
  const candidates = eligibleCandidates(request.messages, policy);
  if (candidates.length === 0 || beforeTokens <= targetTokens) {
    return { request, prunedCount: 0, prunedToolCallIds: [], savedTokens: 0 };
  }

  let messages = request.messages;
  let currentTokens = beforeTokens;
  let prunedCount = 0;
  const prunedToolCallIds: string[] = [];
  for (const candidate of candidates) {
    if (currentTokens <= targetTokens) break;
    const replaced = replaceToolResult(messages, candidate);
    if (!replaced) continue;
    messages = replaced;
    prunedCount += 1;
    prunedToolCallIds.push(candidate.toolCallId);
    currentTokens = estimateTokens({ ...request, messages });
  }

  if (prunedCount === 0) {
    return { request, prunedCount: 0, prunedToolCallIds: [], savedTokens: 0 };
  }
  return {
    request: { ...request, messages },
    prunedCount,
    prunedToolCallIds,
    savedTokens: beforeTokens - currentTokens,
  };
}

function eligibleCandidates(
  messages: readonly ModelMessage[],
  policy: ToolResultPruningPolicy,
): PruningCandidate[] {
  const clearable = new Set(policy.clearableToolNames);
  const candidates: PruningCandidate[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "tool") continue;
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== "tool-result") continue;
      if (!clearable.has(part.toolName)) continue;
      if (part.output.type !== "text") continue;
      if (part.output.value === PRUNED_TOOL_RESULT_TEXT) continue;
      candidates.push({ messageIndex, partIndex, toolCallId: part.toolCallId });
    }
  }

  const resultStart = Math.max(0, candidates.length - policy.protectedRecentResults);
  const messageStart = Math.max(0, messages.length - policy.protectedRecentMessages);
  return candidates.filter(
    (candidate, index) => index < resultStart && candidate.messageIndex < messageStart,
  );
}

function replaceToolResult(
  messages: readonly ModelMessage[],
  candidate: PruningCandidate,
): ModelMessage[] | undefined {
  const message = messages[candidate.messageIndex];
  if (message?.role !== "tool") return undefined;
  const part = message.content[candidate.partIndex];
  if (part?.type !== "tool-result" || part.output.type !== "text") return undefined;
  if (part.output.value === PRUNED_TOOL_RESULT_TEXT) return undefined;

  const output: ToolResultPart["output"] = {
    type: "text",
    value: PRUNED_TOOL_RESULT_TEXT,
  };
  const content = message.content.map((item, index) =>
    index === candidate.partIndex ? { ...part, output } : item,
  );
  const next = messages.slice();
  next[candidate.messageIndex] = { ...message, content };
  return next;
}
