/** 从 journal 计算并写回崩溃恢复事实；未完成事实只收口一次。 */
import type { SessionEventEnvelope } from "@answra/shared/schema";
import type { SessionId, SessionRecoveryPlan, StepProjection, TurnProjection } from "./contracts";
import type { SessionJournal } from "./journal";
import { projectSession } from "./projection";

const INTERRUPTED_STEP_ERROR = "Session 恢复时发现 Step 未完成";
const INTERRUPTED_TURN_ERROR = "Session 恢复时发现 Turn 未完成";
const INTERRUPTED_COMPACTION_ERROR = "Session 恢复时发现压缩未完成";

export function planSessionRecovery(
  sessionId: SessionId,
  events: readonly SessionEventEnvelope[],
): SessionRecoveryPlan {
  const projection = projectSession(sessionId, events);
  const interruptedTurnIds = projection.turns
    .filter((turn) => turn.status === "running")
    .map((turn) => turn.turnId);
  const interruptedStepIds = projection.steps
    .filter((step) => step.status === "running")
    .map((step) => step.stepId);
  const interruptedCompactionIds = projection.compactions
    .filter((compaction) => compaction.state === "started")
    .map((compaction) => compaction.operationId);

  return {
    projection,
    interruptedTurnIds,
    interruptedStepIds,
    interruptedCompactionIds,
  };
}

/** 收口启动前未完成的 Step、Turn 和压缩；重复调用不会重复追加终态。 */
export async function recoverSession(
  journal: SessionJournal,
  sessionId: SessionId,
): Promise<SessionRecoveryPlan> {
  const events = await journal.readAfter(sessionId, 0);
  const plan = planSessionRecovery(sessionId, events);

  for (const id of plan.interruptedStepIds) {
    const step = requireInterruptedStep(plan, id);
    await journal.append(
      sessionId,
      {
        type: "step-finished",
        stepId: step.stepId,
        index: step.index,
        state: "failed",
        finishReason: "error",
        errorText: INTERRUPTED_STEP_ERROR,
      },
      {
        turnId: step.turnId,
        stepId: step.stepId,
        ...(step.messageId === undefined ? {} : { messageId: step.messageId }),
      },
    );
  }

  for (const id of plan.interruptedTurnIds) {
    const turn = requireInterruptedTurn(plan, id);
    await journal.append(
      sessionId,
      {
        type: "turn-finished",
        status: "failed",
        reason: "interrupted",
        errorText: INTERRUPTED_TURN_ERROR,
      },
      { turnId: turn.turnId },
    );
  }

  for (const operationId of plan.interruptedCompactionIds) {
    await journal.append(
      sessionId,
      { type: "compaction-failed", errorText: INTERRUPTED_COMPACTION_ERROR },
      { operationId },
    );
  }

  return plan;
}

function requireInterruptedStep(plan: SessionRecoveryPlan, id: StepProjection["stepId"]) {
  const step = plan.projection.steps.find((candidate) => candidate.stepId === id);
  if (step === undefined) throw new Error(`恢复计划缺少 interrupted Step：${id}`);
  return step;
}

function requireInterruptedTurn(plan: SessionRecoveryPlan, id: TurnProjection["turnId"]) {
  const turn = plan.projection.turns.find((candidate) => candidate.turnId === id);
  if (turn === undefined) throw new Error(`恢复计划缺少 interrupted Turn：${id}`);
  return turn;
}
