/** TUI 通知队列：优先级、key 去重与推进规则；纯状态迁移，不依赖 Ink、计时器或 store。 */

export type TuiNotificationTone = "info" | "success" | "warning" | "error";

/** 与 Claude Code 的通知优先级一致：immediate 插队，其余按级别选择下一条。 */
export type TuiNotificationPriority = "immediate" | "high" | "medium" | "low";

/** 默认自动消失时间，对齐 Claude Code 的 DEFAULT_TIMEOUT_MS。 */
export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 8_000;

export interface TuiNotification {
  readonly key: string;
  readonly text: string;
  readonly tone?: TuiNotificationTone;
  readonly priority?: TuiNotificationPriority;
  /** 自动消失毫秒；null 表示阻塞式提示，必须由流程显式移除。 */
  readonly timeoutMs?: number | null;
}

export interface TuiNotificationState {
  readonly current: TuiNotification | null;
  readonly queue: readonly TuiNotification[];
}

export const EMPTY_NOTIFICATION_STATE: TuiNotificationState = {
  current: null,
  queue: [],
};

const PRIORITY_ORDER: Record<TuiNotificationPriority, number> = {
  immediate: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function addNotification(
  state: TuiNotificationState,
  incoming: TuiNotification,
): TuiNotificationState {
  if (state.current?.key === incoming.key) {
    return { ...state, current: incoming };
  }
  const queueIndex = state.queue.findIndex((item) => item.key === incoming.key);
  if (queueIndex >= 0) {
    const queue = [...state.queue];
    queue[queueIndex] = incoming;
    return { ...state, queue };
  }
  if (state.current === null) {
    return { current: incoming, queue: state.queue };
  }
  if (incoming.priority === "immediate") {
    return { current: incoming, queue: [state.current, ...state.queue] };
  }
  return { ...state, queue: [...state.queue, incoming] };
}

export function removeNotification(state: TuiNotificationState, key: string): TuiNotificationState {
  if (state.current?.key === key) {
    return promoteNext({ current: null, queue: state.queue });
  }
  if (!state.queue.some((item) => item.key === key)) return state;
  return { ...state, queue: state.queue.filter((item) => item.key !== key) };
}

export function promoteNext(state: TuiNotificationState): TuiNotificationState {
  if (state.current !== null || state.queue.length === 0) return state;
  const next = highestPriority(state.queue);
  if (next === undefined) return state;
  return {
    current: next,
    queue: state.queue.filter((item) => item !== next),
  };
}

export function notificationTimeoutMs(notification: TuiNotification): number | null {
  return notification.timeoutMs === undefined
    ? DEFAULT_NOTIFICATION_TIMEOUT_MS
    : notification.timeoutMs;
}

function highestPriority(queue: readonly TuiNotification[]): TuiNotification | undefined {
  let best: TuiNotification | undefined;
  for (const item of queue) {
    if (best === undefined || priorityRank(item) < priorityRank(best)) best = item;
  }
  return best;
}

function priorityRank(notification: TuiNotification): number {
  return PRIORITY_ORDER[notification.priority ?? "low"];
}
