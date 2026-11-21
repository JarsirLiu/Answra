/** Conversation 领域 Step 绑定：按 agentId 解析 Bot、构建模型输入并解析交接结果；不写 transcript 或 Turn 状态。 */
import type { ConversationSendRequest } from "@answra/shared";
import type { ConversationAgentInput } from "../bots/general/agent";
import type { AgentModelRequest, AgentToolOutputEmitter } from "../core/agent/definition";
import type { StepStart, TurnHandoff } from "../core/session/contracts";
import type { ConversationBotCatalog } from "./bots/types";

export interface ConversationStepBindingOptions {
  catalog: ConversationBotCatalog;
  workspaceRoot: () => string | null;
}

export interface ConversationStepBinding {
  prepare(
    step: StepStart,
    signal: AbortSignal,
    emitter: AgentToolOutputEmitter,
  ): Promise<AgentModelRequest>;
  resolveHandoff(step: StepStart): Promise<TurnHandoff | undefined>;
}

/** 按 StepStart.agentId 解析当前 Bot；交接输入优先于 Turn 用户输入。 */
export function createConversationStepBinding({
  catalog,
  workspaceRoot,
}: ConversationStepBindingOptions): ConversationStepBinding {
  const agentNames = new Map(catalog.list().map((bot) => [bot.id, bot.name]));

  function inputFor(step: StepStart): ConversationAgentInput {
    const bot = catalog.require(step.agentId);
    return {
      conversationId: step.sessionId,
      runId: step.stepId,
      request: requestFor(step),
      profile: bot.policy,
      workspaceRoot: workspaceRoot(),
      viewerAgentId: bot.id,
      agentNames,
    };
  }

  return {
    async prepare(step, signal, emitter) {
      const bot = catalog.require(step.agentId);
      return bot.executor.prepare(inputFor(step), signal, emitter);
    },
    async resolveHandoff(step) {
      const bot = catalog.require(step.agentId);
      const result = await bot.executor.result?.(inputFor(step), step.stepId);
      return result === undefined ? undefined : { toAgentId: result.to, task: result.task };
    },
  };
}

function requestFor(step: StepStart): ConversationSendRequest {
  if (step.handoff) return { text: step.handoff.task, images: [] };
  if (step.input)
    return { text: step.input.text, images: step.input.images.map((image) => ({ ...image })) };
  throw new Error(`Step 缺少输入：${step.stepId}`);
}
