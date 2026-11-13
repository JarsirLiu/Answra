/** 上下文的模型窗口预算；只计算阈值，不读取 store、prompt 或模型实现。 */
import type { ModelMessage, ToolSet } from "ai";

/** 构造预算所需的模型能力与产品预留；数值均以 token 为单位。 */
export interface ContextBudgetPolicy {
  /** 模型总上下文窗口，包含输入和输出。 */
  contextWindow: number;
  /** 正常回答和推理需要预留的最大输出。 */
  maxOutputTokens: number;
  /** 估算误差、协议开销和 tokenizer 差异的保守预留。 */
  safetyTokens: number;
  /** 无法精确投影 system/tools 时的固定开销估算，也是校准起点。 */
  fixedOverheadTokens: number;
  /** 最大上下文到摘要压缩触发点之间的缓冲。 */
  compactionBuffer: number;
  /** 重复工具结果清理的触发点；本阶段只保留预算字段，不执行清理。 */
  pruneAt: number;
  /** 重复工具结果清理后的目标上下文。 */
  pruneTarget: number;
  /** 一次清理必须达到的最小净节省。 */
  minPruneSaving: number;
}

/** 解析后的硬上限与触发点；业务只消费这些派生值。 */
export interface ResolvedContextBudget {
  contextWindow: number;
  maxOutputTokens: number;
  safetyTokens: number;
  fixedOverheadTokens: number;
  compactionBuffer: number;
  /** 允许进入模型的全部输入上限，包含 system、tools、历史和当前请求。 */
  inputLimit: number;
  /** 摘要压缩触发点；必须不高于 inputLimit。 */
  compactAt: number;
  pruneAt: number;
  pruneTarget: number;
  minPruneSaving: number;
}

/** 256k 窗口的首版产品预算：20k 输出 + 12k 安全余量 + 8k 固定开销，压缩点在 216k。 */
export const DEFAULT_CONTEXT_BUDGET_POLICY: ContextBudgetPolicy = {
  contextWindow: 256_000,
  maxOutputTokens: 20_000,
  safetyTokens: 12_000,
  fixedOverheadTokens: 8_000,
  compactionBuffer: 40_000,
  pruneAt: 172_000,
  pruneTarget: 40_000,
  minPruneSaving: 132_000,
};

/** 估算后的最终请求；system/tools 已包含在估算内，不重复加 fixedOverheadTokens。 */
export interface ContextModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
}

export function resolveContextBudget(
  policy: ContextBudgetPolicy = DEFAULT_CONTEXT_BUDGET_POLICY,
): ResolvedContextBudget {
  assertPositiveInteger(policy.contextWindow, "contextWindow");
  assertPositiveInteger(policy.maxOutputTokens, "maxOutputTokens");
  assertNonNegativeInteger(policy.safetyTokens, "safetyTokens");
  assertNonNegativeInteger(policy.fixedOverheadTokens, "fixedOverheadTokens");
  assertPositiveInteger(policy.compactionBuffer, "compactionBuffer");
  assertPositiveInteger(policy.pruneAt, "pruneAt");
  assertNonNegativeInteger(policy.pruneTarget, "pruneTarget");
  assertNonNegativeInteger(policy.minPruneSaving, "minPruneSaving");

  const inputLimit =
    policy.contextWindow -
    policy.maxOutputTokens -
    policy.safetyTokens -
    policy.fixedOverheadTokens;
  if (inputLimit <= 0) throw new Error("上下文窗口不足以容纳输出、安全余量与固定开销");

  const compactAt = Math.min(policy.contextWindow - policy.compactionBuffer, inputLimit);
  if (compactAt <= 0) throw new Error("上下文压缩触发点必须为正数");
  if (policy.pruneAt >= compactAt) throw new Error("工具结果清理触发点必须低于摘要压缩触发点");
  if (policy.pruneTarget >= policy.pruneAt) throw new Error("工具结果清理目标必须低于触发点");

  return {
    contextWindow: policy.contextWindow,
    maxOutputTokens: policy.maxOutputTokens,
    safetyTokens: policy.safetyTokens,
    fixedOverheadTokens: policy.fixedOverheadTokens,
    compactionBuffer: policy.compactionBuffer,
    inputLimit,
    compactAt,
    pruneAt: policy.pruneAt,
    pruneTarget: policy.pruneTarget,
    minPruneSaving: policy.minPruneSaving,
  };
}

/** 最终请求仍超过输入硬上限；调用方必须阻止发送，而不是静默截断。 */
export class ContextLimitExceededError extends Error {
  readonly estimatedTokens: number;
  readonly inputLimit: number;

  constructor({ estimatedTokens, inputLimit }: { estimatedTokens: number; inputLimit: number }) {
    super(`上下文估算 ${estimatedTokens} token，超过输入上限 ${inputLimit}`);
    this.name = "ContextLimitExceededError";
    this.estimatedTokens = estimatedTokens;
    this.inputLimit = inputLimit;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
}
