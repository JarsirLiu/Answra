/** 一轮问答的 Turn 内编排：当前 Bot、step 循环与同 Turn handoff；不写终态事件。 */
import { randomUUID } from "node:crypto";
import { assertHandoffTask } from "../team/handoff";
import type {
  StepExecutor,
  StepHandoff,
  StepId,
  StepResult,
  TurnExecutor,
  TurnFinish,
  TurnHandoff,
  TurnRunContext,
  TurnStart,
} from "./contracts";
import { stepId } from "./contracts";
import type { SessionJournal } from "./journal";
import { sessionErrorText } from "./sessionErrorText";

const DEFAULT_MAX_TURN_STEPS = 32;

export interface SessionTurnExecutorOptions {
  journal: SessionJournal;
  stepExecutor: StepExecutor;
  /** assistant 消息 id 由 transcript 宿主提供；TurnExecutor 不拥有消息身份。 */
  createMessageId: () => string;
  createStepId?: () => StepId;
  maxSteps?: number;
}

export class SessionTurnExecutor implements TurnExecutor {
  private readonly journal: SessionJournal;
  private readonly stepExecutor: StepExecutor;
  private readonly createStepId: () => StepId;
  private readonly createMessageId: () => string;
  private readonly maxSteps: number;

  constructor({
    journal,
    stepExecutor,
    createMessageId,
    createStepId = () => stepId(randomUUID()),
    maxSteps = DEFAULT_MAX_TURN_STEPS,
  }: SessionTurnExecutorOptions) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1)
      throw new Error("Turn 最大 step 数必须为正整数");
    this.journal = journal;
    this.stepExecutor = stepExecutor;
    this.createStepId = createStepId;
    this.createMessageId = createMessageId;
    this.maxSteps = maxSteps;
  }

  async run(turn: TurnStart, runtime: TurnRunContext, signal: AbortSignal): Promise<TurnFinish> {
    let agentId = turn.agentId;
    let messageId = turn.messageId;
    let handoff: StepHandoff | undefined;
    let index = 0;

    while (true) {
      if (signal.aborted) return finish(turn, "aborted", "cancelled");
      if (index >= this.maxSteps) {
        return finish(
          turn,
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

      if (result.outcome === "aborted" || signal.aborted) {
        return finish(turn, "aborted", "cancelled");
      }
      if (result.outcome === "failed") return failedFinish(turn, result);
      if (result.finishReason === "error")
        return finish(turn, "failed", "model-error", result.errorText);

      if (result.handoff !== undefined) {
        const fromAgentId = agentId;
        const nextHandoff = normalizeHandoff(result.handoff);
        const handoffError = validateHandoff(fromAgentId, nextHandoff);
        if (handoffError !== undefined)
          return finish(turn, "failed", "handoff-failed", handoffError);
        const sourceMessageId = messageId;
        await this.appendHandoff(turn, fromAgentId, sourceMessageId, nextHandoff);
        agentId = nextHandoff.toAgentId;
        messageId = this.createMessageId();
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

      return finish(turn, "completed", "completed");
    }
  }

  private async appendHandoff(
    turn: TurnStart,
    fromAgentId: string,
    messageId: string,
    handoff: TurnHandoff,
  ): Promise<void> {
    await this.journal.append(
      turn.sessionId,
      {
        type: "turn-handoff",
        fromAgentId,
        toAgentId: handoff.toAgentId,
        task: handoff.task,
      },
      { turnId: turn.turnId, messageId },
    );
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

function failedFinish(turn: TurnStart, result: StepResult): TurnFinish {
  return finish(
    turn,
    "failed",
    result.finishReason === "error" ? "model-error" : "unknown",
    result.errorText,
  );
}

function finish(
  turn: TurnStart,
  outcome: TurnFinish["outcome"],
  reason: TurnFinish["reason"],
  errorText?: string,
): TurnFinish {
  return {
    turnId: turn.turnId,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(errorText === undefined ? {} : { errorText }),
  };
}
