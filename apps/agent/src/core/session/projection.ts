/** Session 事件投影：纯 reducer，不写 journal、不调用模型或工具。 */
import type { SessionEventEnvelope, TurnFinishReason, TurnStatus } from "@answra/shared/schema";
import type {
  CompactionProjection,
  SessionId,
  SessionProjection,
  StepProjection,
  TurnId,
  TurnProjection,
} from "./contracts";
import { stepId, turnId } from "./contracts";

export function emptyProjection(sessionId: SessionId): SessionProjection {
  return {
    sessionId,
    sequence: 0,
    turns: [],
    queue: [],
    steps: [],
    compactions: [],
  };
}

export function projectSession(
  sessionId: SessionId,
  events: readonly SessionEventEnvelope[],
): SessionProjection {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  let state = emptyProjection(sessionId);
  for (const envelope of sorted) state = applySessionEvent(state, envelope);
  return state;
}

export function applySessionEvent(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  if (envelope.sessionId !== state.sessionId) {
    throw new Error(`事件 session 不匹配：${envelope.sessionId} != ${state.sessionId}`);
  }
  if (envelope.sequence !== state.sequence + 1) {
    throw new Error(`Session 事件 sequence 不连续：${state.sequence} -> ${envelope.sequence}`);
  }

  const next = applyEvent(state, envelope);
  return { ...next, sequence: envelope.sequence };
}

function applyEvent(state: SessionProjection, envelope: SessionEventEnvelope): SessionProjection {
  const event = envelope.event;
  switch (event.type) {
    case "turn-queued":
      return applyTurnQueued(state, envelope);
    case "turn-started":
      return applyTurnStarted(state, envelope);
    case "turn-finished":
      return applyTurnFinished(state, envelope);
    case "turn-handoff":
      return applyTurnHandoff(state, envelope);
    case "step-started":
      return applyStepStarted(state, envelope);
    case "step-finished":
      return applyStepFinished(state, envelope);
    case "context-usage-changed":
      return {
        ...state,
        contextUsage: { usedTokens: event.usedTokens, updatedAt: envelope.occurredAt },
      };
    case "compaction-started":
      return applyCompactionStarted(state, envelope);
    case "compaction-finished":
      return applyCompactionFinished(state, envelope);
    case "compaction-failed":
      return applyCompactionFailed(state, envelope);
    case "compaction-aborted":
      return applyCompactionAborted(state, envelope);
    default:
      return state;
  }
}

function applyTurnQueued(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const id = requireTurnId(envelope);
  if (state.turns.some((turn) => turn.turnId === id)) {
    throw new Error(`Turn 已存在：${id}`);
  }
  const event = envelope.event;
  if (event.type !== "turn-queued") return state;
  const turn: TurnProjection = {
    sessionId: state.sessionId,
    turnId: id,
    source: event.source,
    status: "queued",
    agentId: event.agentId,
    assistantMessageIds: [],
    handoffCount: 0,
    ...(event.input === undefined ? {} : { input: event.input }),
    createdAt: envelope.occurredAt,
  };
  return { ...state, turns: [...state.turns, turn], queue: [...state.queue, id] };
}

function applyTurnStarted(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const id = requireTurnId(envelope);
  if (state.activeTurnId !== undefined && state.activeTurnId !== id) {
    throw new Error(`同一 session 只能有一个活动 turn：${state.activeTurnId}`);
  }
  const turn = requireTurn(state, id);
  if (turn.status !== "queued") throw new Error(`Turn 不是 queued：${id}`);
  const event = envelope.event;
  if (event.type !== "turn-started") return state;
  return applyTurnUpdate(
    state,
    id,
    {
      status: "running",
      agentId: event.agentId,
      activeAgentId: event.agentId,
      assistantMessageIds: withAssistantMessageId(turn.assistantMessageIds, envelope.messageId),
      startedAt: envelope.occurredAt,
    },
    {
      activeTurnId: id,
      queue: state.queue.filter((queued) => queued !== id),
    },
  );
}

function applyTurnFinished(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const id = requireTurnId(envelope);
  const turn = requireTurn(state, id);
  const event = envelope.event;
  if (event.type !== "turn-finished") return state;
  if (turn.status === "queued") {
    if (event.status !== "aborted") throw new Error(`queued Turn 只能被取消：${id}`);
    return applyTurnUpdate(
      state,
      id,
      {
        status: "aborted",
        finishReason: event.reason ?? "cancelled",
        finishedAt: envelope.occurredAt,
      },
      { queue: state.queue.filter((queued) => queued !== id) },
    );
  }
  if (turn.status !== "running") throw new Error(`Turn 不是 running：${id}`);
  return applyTurnUpdate(
    state,
    id,
    {
      status: event.status,
      finishReason: event.reason ?? finishReasonForOutcome(event.status),
      ...(event.errorText === undefined ? {} : { errorText: event.errorText }),
      finishedAt: envelope.occurredAt,
    },
    { activeTurnId: state.activeTurnId === id ? undefined : state.activeTurnId },
  );
}

function applyTurnHandoff(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const id = requireTurnId(envelope);
  const turn = requireTurn(state, id);
  if (turn.status !== "running") throw new Error(`Turn 不是 running：${id}`);
  const event = envelope.event;
  if (event.type !== "turn-handoff") return state;
  return applyTurnUpdate(
    state,
    id,
    {
      activeAgentId: event.toAgentId,
      handoffCount: turn.handoffCount + 1,
      assistantMessageIds: withAssistantMessageId(turn.assistantMessageIds, envelope.messageId),
    },
    {},
  );
}

function applyStepStarted(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const id = requireTurnId(envelope);
  const turn = requireTurn(state, id);
  if (turn.status !== "running") throw new Error(`Turn 不是 running：${id}`);
  const event = envelope.event;
  if (event.type !== "step-started") return state;
  const currentStepId = stepId(event.stepId);
  if (state.steps.some((step) => step.stepId === currentStepId)) {
    throw new Error(`Step 已存在：${currentStepId}`);
  }
  const step: StepProjection = {
    stepId: currentStepId,
    sessionId: state.sessionId,
    turnId: id,
    ...(envelope.messageId === undefined ? {} : { messageId: envelope.messageId }),
    ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
    ...(event.modelId === undefined ? {} : { modelId: event.modelId }),
    index: event.index,
    status: "running",
    startedAt: envelope.occurredAt,
  };
  const withMessage = applyTurnUpdate(
    state,
    id,
    { assistantMessageIds: withAssistantMessageId(turn.assistantMessageIds, envelope.messageId) },
    {},
  );
  return { ...withMessage, steps: [...withMessage.steps, step] };
}

function applyStepFinished(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const event = envelope.event;
  if (event.type !== "step-finished") return state;
  const currentStepId = stepId(event.stepId);
  const existing = state.steps.find((step) => step.stepId === currentStepId);
  if (!existing) throw new Error(`Step 不存在：${currentStepId}`);
  const step: StepProjection = {
    ...existing,
    status: event.state,
    ...(event.finishReason === undefined ? {} : { finishReason: event.finishReason }),
    ...(event.usage === undefined ? {} : { usage: event.usage }),
    ...(event.errorText === undefined ? {} : { errorText: event.errorText }),
    finishedAt: envelope.occurredAt,
  };
  return {
    ...state,
    steps: state.steps.map((candidate) => (candidate.stepId === currentStepId ? step : candidate)),
  };
}

function applyCompactionStarted(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const operationId = requireOperationId(envelope);
  if (state.compactions.some((compaction) => compaction.operationId === operationId)) {
    throw new Error(`压缩操作已存在：${operationId}`);
  }
  const event = envelope.event;
  if (event.type !== "compaction-started") return state;
  const compaction: CompactionProjection = {
    operationId,
    trigger: event.trigger,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    state: "started",
    startedAt: envelope.occurredAt,
  };
  return { ...state, compactions: [...state.compactions, compaction] };
}

function applyCompactionFinished(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const operationId = requireOperationId(envelope);
  const existing = requireCompaction(state, operationId);
  const event = envelope.event;
  if (event.type !== "compaction-finished") return state;
  return updateCompaction(state, operationId, {
    ...existing,
    state: "succeeded",
    summarizedMessages: event.summarizedMessages,
    summary: event.summary,
    ...(event.usage === undefined ? {} : { usage: event.usage }),
    finishedAt: envelope.occurredAt,
  });
}

function applyCompactionFailed(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const operationId = requireOperationId(envelope);
  const existing = requireCompaction(state, operationId);
  const event = envelope.event;
  if (event.type !== "compaction-failed") return state;
  return updateCompaction(state, operationId, {
    ...existing,
    state: "failed",
    errorText: event.errorText,
    finishedAt: envelope.occurredAt,
  });
}

function applyCompactionAborted(
  state: SessionProjection,
  envelope: SessionEventEnvelope,
): SessionProjection {
  const operationId = requireOperationId(envelope);
  const existing = requireCompaction(state, operationId);
  return updateCompaction(state, operationId, {
    ...existing,
    state: "aborted",
    finishedAt: envelope.occurredAt,
  });
}

function applyTurnUpdate(
  state: SessionProjection,
  id: TurnId,
  update: Partial<TurnProjection>,
  stateUpdate: Partial<SessionProjection>,
): SessionProjection {
  return {
    ...state,
    ...stateUpdate,
    turns: state.turns.map((turn) => (turn.turnId === id ? { ...turn, ...update } : turn)),
  };
}

function withAssistantMessageId(
  current: readonly string[],
  messageId: string | undefined,
): readonly string[] {
  if (messageId === undefined || current.includes(messageId)) return current;
  return [...current, messageId];
}

function updateCompaction(
  state: SessionProjection,
  operationId: string,
  compaction: CompactionProjection,
): SessionProjection {
  return {
    ...state,
    compactions: state.compactions.map((candidate) =>
      candidate.operationId === operationId ? compaction : candidate,
    ),
  };
}

function requireTurn(state: SessionProjection, id: TurnId): TurnProjection {
  const turn = state.turns.find((candidate) => candidate.turnId === id);
  if (!turn) throw new Error(`Turn 不存在：${id}`);
  return turn;
}

function requireCompaction(state: SessionProjection, operationId: string): CompactionProjection {
  const compaction = state.compactions.find((candidate) => candidate.operationId === operationId);
  if (!compaction) throw new Error(`压缩操作不存在：${operationId}`);
  return compaction;
}

function requireTurnId(envelope: SessionEventEnvelope): TurnId {
  if (envelope.turnId === undefined) throw new Error(`${envelope.event.type} 缺少 turnId`);
  return turnId(envelope.turnId);
}

function requireOperationId(envelope: SessionEventEnvelope): string {
  if (envelope.operationId === undefined)
    throw new Error(`${envelope.event.type} 缺少 operationId`);
  return envelope.operationId;
}

function finishReasonForOutcome(status: TurnStatus): TurnFinishReason {
  if (status === "completed") return "completed";
  if (status === "aborted") return "cancelled";
  return "unknown";
}
