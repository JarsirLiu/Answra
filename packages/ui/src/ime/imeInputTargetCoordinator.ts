import type { ImeSessionSnapshot } from "@answra/shared";
import { getLatestImeSessionSnapshot, resetImeSessionClientForTests } from "./imeSessionClient";

interface ActiveTarget {
  id: string;
  deactivate: () => void;
}

let activeTarget: ActiveTarget | undefined;
let inputQueue: Promise<void> = Promise.resolve();

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
}

export function releaseImeInputTarget(id: string): void {
  if (activeTarget?.id === id) activeTarget = undefined;
}

export function isActiveImeInputTarget(id: string): boolean {
  return activeTarget?.id === id;
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
  resetImeSessionClientForTests();
}
