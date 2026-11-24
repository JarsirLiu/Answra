/** 一轮问答的 Turn 内编排：当前 Bot、step 循环与同 Turn handoff；不写终态条目。 */
import { randomUUID } from "node:crypto";
import type { AgentFinishReason, AgentUsage } from "@answra/shared/schema";
import { assertHandoffTask } from "../team/handoff";
import type {
  StepExecutor,
  StepHandoff,
  StepId,
  StepResult,
  TurnExecutor,
  TurnFinish,
  TurnHandoff,
  TurnRecorder,
  TurnRunContext,
  TurnStart,
} from "./contracts";
import { stepId } from "./contracts";
import { sessionErrorText } from "./sessionErrorText";

const DEFAULT_MAX_TURN_STEPS = 32;

export interface SessionTurnExecutorOptions {
  recorder: TurnRecorder;
  stepExecutor: StepExecutor;
  /** assistant 消息 id 由 transcript 宿主提供；TurnExecutor 不拥有消息身份。 */
  createMessageId: () => string;
  createStepId?: () => StepId;
  maxSteps?: number;
  now?: () => Date;
}

/** 本 Turn 已执行的 step 统计；`turn-end` 直接落库，不再有第二份 step 事实。 */
interface TurnStats {
  finishReason?: AgentFinishReason;
  usage?: AgentUsage;
}

export class SessionTurnExecutor implements TurnExecutor {
  private readonly recorder: TurnRecorder;
  private readonly stepExecutor: StepExecutor;
  private readonly createStepId: () => StepId;
  private readonly createMessageId: () => string;
  private readonly maxSteps: number;
  private readonly now: () => Date;

  constructor({
    recorder,
    stepExecutor,
    createMessageId,
    createStepId = () => stepId(randomUUID()),
    maxSteps = DEFAULT_MAX_TURN_STEPS,
    now = () => new Date(),
  }: SessionTurnExecutorOptions) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1)
      throw new Error("Turn 最大 step 数必须为正整数");
    this.recorder = recorder;
    this.stepExecutor = stepExecutor;
    this.createStepId = createStepId;
    this.createMessageId = createMessageId;
    this.maxSteps = maxSteps;
    this.now = now;
  }

  async run(turn: TurnStart, runtime: TurnRunContext, signal: AbortSignal): Promise<TurnFinish> {
    const startedAt = this.now().getTime();
    let agentId = turn.agentId;
    let messageId = turn.messageId;
    let handoff: StepHandoff | undefined;
    let index = 0;
    let executed = 0;
    const stats: TurnStats = {};

    const done = (
      outcome: TurnFinish["outcome"],
      reason: TurnFinish["reason"],
      errorText?: string,
    ): TurnFinish =>
      finish(
        turn,
        outcome,
        reason,
        stats,
        { steps: executed, durationMs: this.now().getTime() - startedAt },
        errorText,
      );

    while (true) {
      if (signal.aborted) return done("aborted", "cancelled");
      if (index >= this.maxSteps) {
        return done(
          "failed",
          "unknown",
          `Turn 超过最大 step 数 ${this.maxSteps}，已停止以避免无限循环`,
        );
      }

      const result = await this.stepExecutor.run(
        {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          stepId: this.createStepId(),
          index,
          agentId,
          source: turn.source,
          messageId,
          ...(turn.input === undefined ? {} : { input: turn.input }),
          ...(handoff === undefined ? {} : { handoff }),
        },
        runtime,
        signal,
      );
      executed += 1;
      if (result.usage !== undefined) stats.usage = result.usage;
      if (result.finishReason !== undefined) stats.finishReason = result.finishReason;

      if (result.outcome === "aborted" || signal.aborted) return done("aborted", "cancelled");
      if (result.outcome === "failed") return failedFinish(result, done);
      if (result.finishReason === "error") return done("failed", "model-error", result.errorText);

      if (result.continuation === "context-recovered") {
        index += 1;
        continue;
      }

      if (result.handoff !== undefined) {
        const fromAgentId = agentId;
        const nextHandoff = normalizeHandoff(result.handoff);
        const handoffError = validateHandoff(fromAgentId, nextHandoff);
        if (handoffError !== undefined) return done("failed", "handoff-failed", handoffError);
        const sourceMessageId = messageId;
        const nextMessageId = this.createMessageId();
        await this.recorder.recordHandoff(turn.sessionId, {
          turnId: turn.turnId,
          fromAgentId,
          toAgentId: nextHandoff.toAgentId,
          task: nextHandoff.task,
          sourceMessageId,
          nextMessageId,
        });
        agentId = nextHandoff.toAgentId;
        messageId = nextMessageId;
        handoff = {
          fromAgentId,
          task: nextHandoff.task,
          sourceMessageId,
        };
        index += 1;
        continue;
      }

      if (result.finishReason === "tool-calls") {
        index += 1;
        continue;
      }

      return done("completed", "completed");
    }
  }
}

function normalizeHandoff(handoff: TurnHandoff): TurnHandoff {
  return {
    toAgentId: handoff.toAgentId.trim(),
    task: handoff.task.trim(),
  };
}

function validateHandoff(fromAgentId: string, handoff: TurnHandoff): string | undefined {
  if (!handoff.toAgentId) return "交接目标不能为空";
  if (handoff.toAgentId === fromAgentId) return "交接目标不能是当前 Bot";
  try {
    assertHandoffTask(handoff.task);
    return undefined;
  } catch (error) {
    return sessionErrorText(error);
  }
}

function failedFinish(
  result: StepResult,
  done: (
    outcome: TurnFinish["outcome"],
    reason: TurnFinish["reason"],
    errorText?: string,
  ) => TurnFinish,
): TurnFinish {
  return done(
    "failed",
    result.finishReason === "error" ? "model-error" : "unknown",
    result.errorText,
  );
}

function finish(
  turn: TurnStart,
  outcome: TurnFinish["outcome"],
  reason: TurnFinish["reason"],
  stats: TurnStats,
  counters: { steps: number; durationMs: number },
  errorText?: string,
): TurnFinish {
  return {
    turnId: turn.turnId,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(errorText === undefined ? {} : { errorText }),
    steps: counters.steps,
    durationMs: counters.durationMs,
    ...(stats.finishReason === undefined ? {} : { finishReason: stats.finishReason }),
    ...(stats.usage === undefined ? {} : { usage: stats.usage }),
  };
}
