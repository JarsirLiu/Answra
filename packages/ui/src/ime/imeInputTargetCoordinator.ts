import type { ImeSessionSnapshot } from "@answra/shared";
import { getLatestImeSessionSnapshot, resetImeSessionClientForTests } from "./imeSessionClient";

interface ActiveTarget {
  id: string;
  deactivate: () => void;
}

let activeTarget: ActiveTarget | undefined;
let inputQueue: Promise<void> = Promise.resolve();
const targetListeners = new Set<() => void>();

function notifyTargetChange(): void {
  for (const listener of targetListeners) listener();
}

/** Keeps one focused IME target per renderer and invalidates its predecessor on switch. */
export function activateImeInputTarget(id: string, deactivate: () => void): void {
  if (activeTarget?.id === id) {
    activeTarget.deactivate = deactivate;
    return;
  }
  const previous = activeTarget;
  activeTarget = undefined;
  previous?.deactivate();
  activeTarget = { id, deactivate };
  notifyTargetChange();
}

export function releaseImeInputTarget(id: string): void {
  if (activeTarget?.id !== id) return;
  activeTarget = undefined;
  notifyTargetChange();
}

export function isActiveImeInputTarget(id: string): boolean {
  return activeTarget?.id === id;
}

/**
 * The renderer's active input target as an external-store snapshot. Components derive
 * "is this target registered" from here instead of keeping their own focus copy; the
 * string identity stays stable while the fact is unchanged.
 */
export function getActiveImeInputTargetId(): string | undefined {
  return activeTarget?.id;
}

export function subscribeImeInputTargets(listener: () => void): () => void {
  targetListeners.add(listener);
  return () => targetListeners.delete(listener);
}

/** Serializes input work across hook instances in this renderer. */
export function enqueueImeInput<T>(
  targetId: string,
  operation: (snapshot: ImeSessionSnapshot | undefined) => Promise<T>,
): Promise<T | undefined> {
  const result = inputQueue.then(async () => {
    if (!isActiveImeInputTarget(targetId)) return undefined;
    return operation(getLatestImeSessionSnapshot());
  });
  inputQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function resetImeInputTargetCoordinatorForTests(): void {
  activeTarget = undefined;
  inputQueue = Promise.resolve();
  targetListeners.clear();
  resetImeSessionClientForTests();
}
