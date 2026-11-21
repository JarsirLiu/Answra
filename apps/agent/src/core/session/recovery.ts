/** 从 journal 计算崩溃恢复计划；只报告未收口事实，不自行追加事件。 */
import type { SessionEventEnvelope } from "@answra/shared/schema";
import type { SessionId, SessionRecoveryPlan } from "./contracts";
import { projectSession } from "./projection";

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
    .filter((compaction) => compaction.status === "started")
    .map((compaction) => compaction.operationId);

  return {
    projection,
    interruptedTurnIds,
    interruptedStepIds,
    interruptedCompactionIds,
  };
}
