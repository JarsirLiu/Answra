/** 上下文压缩的独立生命周期；不复用 Agent run 状态机。 */
import type {
  ContextCompactionState,
  ContextCompactionStatus,
  ContextCompactionTrigger,
} from "@answra/shared";

const ALLOWED_TRANSITIONS: Record<ContextCompactionState, readonly ContextCompactionState[]> = {
  idle: ["started"],
  started: ["succeeded", "failed", "aborted"],
  failed: ["started"],
  succeeded: ["started"],
  aborted: ["started"],
};

export function canTransitionContextCompaction(
  from: ContextCompactionState,
  to: ContextCompactionState,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function startContextCompaction({
  previous,
  trigger,
  now,
}: {
  previous: ContextCompactionStatus | undefined;
  trigger: ContextCompactionTrigger;
  now: () => Date;
}): ContextCompactionStatus {
  const from = previous?.state ?? "idle";
  assertTransition(from, "started");
  const at = now().toISOString();
  return { state: "started", trigger, startedAt: at, updatedAt: at };
}

export function markContextCompactionSucceeded(
  status: ContextCompactionStatus,
  summarizedMessages: number,
  now: () => Date,
): ContextCompactionStatus {
  assertTransition(status.state, "succeeded");
  const at = now().toISOString();
  return {
    ...status,
    state: "succeeded",
    updatedAt: at,
    finishedAt: at,
    summarizedMessages,
  };
}

export function markContextCompactionAborted(
  status: ContextCompactionStatus,
  now: () => Date,
): ContextCompactionStatus {
  assertTransition(status.state, "aborted");
  const at = now().toISOString();
  return { ...status, state: "aborted", updatedAt: at, finishedAt: at };
}

export function markContextCompactionFailed(
  status: ContextCompactionStatus,
  errorText: string,
  now: () => Date,
): ContextCompactionStatus {
  assertTransition(status.state, "failed");
  const at = now().toISOString();
  return { ...status, state: "failed", updatedAt: at, finishedAt: at, errorText };
}

function assertTransition(from: ContextCompactionState, to: ContextCompactionState): void {
  if (!canTransitionContextCompaction(from, to))
    throw new Error(`非法上下文压缩状态迁移：${from} -> ${to}`);
}
