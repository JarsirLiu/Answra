/** Interview 领域 Step 绑定：按 TurnSource 构建演练/资料整理输入；不写 transcript 或 Turn 状态。 */
import type { InterviewProfileSeed } from "@answra/shared";
import type {
  AgentExecutor,
  AgentModelRequest,
  AgentToolOutputEmitter,
} from "../core/agent/definition";
import type { StepStart } from "../core/session/contracts";
import type { InterviewAgentInput } from "./contracts";

export interface InterviewStepBindingOptions {
  executor: AgentExecutor<InterviewAgentInput>;
  workspaceRoot: () => string | null;
  interviewDataRoot: () => string | null;
  profileSeed: () => InterviewProfileSeed | null;
  /** 交接说明只对 opening Turn 生效，普通回复不继承。 */
  handoffTask: (conversationId: string) => string | null;
}

export interface InterviewStepBinding {
  prepare(
    step: StepStart,
    signal: AbortSignal,
    emitter: AgentToolOutputEmitter,
  ): Promise<AgentModelRequest>;
}

/**
 * opening 只来自 Turn 的提交来源：它不在 StepStart 的消息或运行状态里可推导，
 * 恢复 queued Turn 时也随 `turn-queued` 持久化，避免领域另存一份开关。
 */
export function createInterviewStepBinding({
  executor,
  workspaceRoot,
  interviewDataRoot,
  profileSeed,
  handoffTask,
}: InterviewStepBindingOptions): InterviewStepBinding {
  return {
    prepare(step, signal, emitter) {
      return executor.prepare(inputFor(step), signal, emitter);
    },
  };

  function inputFor(step: StepStart): InterviewAgentInput {
    const opening = step.source === "opening";
    return {
      conversationId: step.sessionId,
      runId: step.stepId,
      workspaceRoot: workspaceRoot(),
      interviewDataRoot: interviewDataRoot(),
      profileSeed: profileSeed(),
      opening,
      handoffTask: opening ? handoffTask(step.sessionId) : null,
    };
  }
}
