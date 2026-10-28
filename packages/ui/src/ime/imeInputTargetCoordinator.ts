import type { ImeSessionSnapshot } from "@answra/shared";
import { getLatestImeSessionSnapshot, resetImeSessionClientForTests } from "./imeSessionClient";

interface ActiveTarget {
  id: string;
  deactivate: () => void;
  epoch: number;
}

export interface ImeInputEventContext {
  eventId: number;
  targetId: string;
  targetEpoch: number;
  snapshot: ImeSessionSnapshot | undefined;
}

let activeTarget: ActiveTarget | undefined;
let inputQueue: Promise<void> = Promise.resolve();
let nextEventId = 1;
let nextTargetEpoch = 1;
let pendingKeys = 0;
let disposed = false;
const targetListeners = new Set<() => void>();

function notifyTargetChange(): void {
  for (const listener of targetListeners) listener();
}

/** Keeps one focused IME target per renderer and invalidates its predecessor on switch. */
export function activateImeInputTarget(id: string, deactivate: () => void): void {
  if (disposed) return;
  if (activeTarget?.id === id) {
    activeTarget.deactivate = deactivate;
    return;
  }
  const previous = activeTarget;
  activeTarget = undefined;
  pendingKeys = 0;
  previous?.deactivate();
  activeTarget = { id, deactivate, epoch: nextTargetEpoch++ };
  notifyTargetChange();
}

export function releaseImeInputTarget(id: string): void {
  if (disposed || activeTarget?.id !== id) return;
  activeTarget = undefined;
  pendingKeys = 0;
  notifyTargetChange();
}

export function isActiveImeInputTarget(id: string): boolean {
  return !disposed && activeTarget?.id === id;
}

export function isCurrentImeInputEvent(targetId: string, targetEpoch: number): boolean {
  return isActiveImeInputTarget(targetId) && activeTarget?.epoch === targetEpoch;
}

/**
 * The renderer's active input target as an external-store snapshot. Components derive
 * "is this target registered" from here instead of keeping their own focus copy; the
 * string identity stays stable while the fact is unchanged.
 */
export function getActiveImeInputTargetId(): string | undefined {
  return disposed ? undefined : activeTarget?.id;
}

export function subscribeImeInputTargets(listener: () => void): () => void {
  targetListeners.add(listener);
  return () => targetListeners.delete(listener);
}

/** Serializes input work across hook instances in this renderer. */
export function enqueueImeInput<T>(
  targetId: string,
  operation: (
    snapshot: ImeSessionSnapshot | undefined,
    context: ImeInputEventContext,
  ) => Promise<T>,
): Promise<T | undefined> {
  const eventId = nextEventId++;
  const queuedEpoch = activeTarget?.id === targetId ? activeTarget.epoch : undefined;
  pendingKeys += 1;
  const result = inputQueue.then(async () => {
    if (
      disposed ||
      activeTarget?.id !== targetId ||
      queuedEpoch === undefined ||
      activeTarget.epoch !== queuedEpoch
    ) {
      return undefined;
    }
    const snapshot = getLatestImeSessionSnapshot();
    return operation(snapshot, { eventId, targetId, targetEpoch: queuedEpoch, snapshot });
  });
  inputQueue = result.then(
    () => {
      pendingKeys = Math.max(0, pendingKeys - 1);
    },
    () => {
      pendingKeys = Math.max(0, pendingKeys - 1);
    },
  );
  return result;
}

export function getImeInputCoordinatorState() {
  return {
    status: disposed ? "disposed" : activeTarget ? "active" : "idle",
    targetId: activeTarget?.id,
    nextEventId,
    pendingKeys,
  } as const;
}

export function disposeImeInputCoordinator(): void {
  if (disposed) return;
  const previous = activeTarget;
  disposed = true;
  activeTarget = undefined;
  pendingKeys = 0;
  previous?.deactivate();
  targetListeners.clear();
}

export function resetImeInputTargetCoordinatorForTests(): void {
  activeTarget = undefined;
  inputQueue = Promise.resolve();
  nextEventId = 1;
  nextTargetEpoch = 1;
  pendingKeys = 0;
  disposed = false;
  targetListeners.clear();
  resetImeSessionClientForTests();
}
