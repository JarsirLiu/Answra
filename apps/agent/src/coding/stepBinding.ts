/** Coding 领域 Step 绑定：按 StepStart 构建单 Bot 模型输入；不写 transcript 或 Turn 状态。 */
import type { ConversationSendRequest } from "@answra/shared";
import type { AgentModelRequest, AgentToolOutputEmitter } from "../core/agent/definition";
import type { StepStart } from "../core/session/contracts";
import type { CodingAgentInput } from "./agent";
import type { CodingBot } from "./bot";

export interface CodingStepBindingOptions {
  bot: CodingBot;
  workspaceRoot: () => string | null;
}

export interface CodingStepBinding {
  prepare(
    step: StepStart,
    signal: AbortSignal,
    emitter: AgentToolOutputEmitter,
  ): Promise<AgentModelRequest>;
}

/** Coding 没有 handoff 与 opening；每次 step 都必须携带用户输入。 */
export function createCodingStepBinding({
  bot,
  workspaceRoot,
}: CodingStepBindingOptions): CodingStepBinding {
  return {
    prepare(step, signal, emitter) {
      return bot.executor.prepare(inputFor(step), signal, emitter);
    },
  };

  function inputFor(step: StepStart): CodingAgentInput {
    return {
      conversationId: step.sessionId,
      runId: step.stepId,
      request: requestFor(step),
      policy: bot.policy,
      workspaceRoot: workspaceRoot(),
    };
  }
}

function requestFor(step: StepStart): ConversationSendRequest {
  if (step.handoff !== undefined) throw new Error(`Coding Turn 不支持交接：${step.stepId}`);
  if (step.input === undefined) throw new Error(`Step 缺少输入：${step.stepId}`);
  return {
    text: step.input.text,
    images: step.input.images.map((image) => ({ ...image })),
  };
}
