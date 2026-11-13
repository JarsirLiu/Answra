/** 旧工具结果清理：只替换最终模型投影中的白名单 tool-result 文本。 */
import type { ModelMessage, ToolResultPart } from "ai";
import type { ContextModelRequest } from "../budget";
import { estimateContextRequestTokens } from "../tokenEstimate";
import type { ToolResultPruningPolicy } from "./policy";

export const PRUNED_TOOL_RESULT_TEXT = "[旧工具结果已清理]";

export interface ToolResultPruningResult {
  readonly request: ContextModelRequest;
  readonly prunedCount: number;
  readonly savedTokens: number;
}

interface PruningCandidate {
  readonly messageIndex: number;
  readonly partIndex: number;
}

/** 按旧到新替换可清理工具结果，直到达到目标 token 或候选耗尽。 */
export function pruneOldToolResults({
  request,
  targetTokens,
  policy,
}: {
  request: ContextModelRequest;
  targetTokens: number;
  policy: ToolResultPruningPolicy;
}): ToolResultPruningResult {
  const beforeTokens = estimateContextRequestTokens(request);
  const candidates = eligibleCandidates(request.messages, policy);
  if (candidates.length === 0 || beforeTokens <= targetTokens) {
    return { request, prunedCount: 0, savedTokens: 0 };
  }

  let messages = request.messages;
  let currentTokens = beforeTokens;
  let prunedCount = 0;
  for (const candidate of candidates) {
    if (currentTokens <= targetTokens) break;
    const replaced = replaceToolResult(messages, candidate);
    if (!replaced) continue;
    messages = replaced;
    prunedCount += 1;
    currentTokens = estimateContextRequestTokens({ ...request, messages });
  }

  if (prunedCount === 0) return { request, prunedCount: 0, savedTokens: 0 };
  return {
    request: { ...request, messages },
    prunedCount,
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
      candidates.push({ messageIndex, partIndex });
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
