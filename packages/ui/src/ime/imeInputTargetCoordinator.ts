import type { ImeSessionSnapshot } from "@answra/shared";

interface ActiveTarget {
  id: string;
  deactivate: () => void;
}

let activeTarget: ActiveTarget | undefined;
let latestSnapshot: ImeSessionSnapshot | undefined;
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

export function publishImeSessionSnapshot(snapshot: ImeSessionSnapshot): void {
  if (!latestSnapshot || snapshot.revision >= latestSnapshot.revision) latestSnapshot = snapshot;
}

export function getLatestImeSessionSnapshot(): ImeSessionSnapshot | undefined {
  return latestSnapshot;
}

/** Serializes input work across hook instances in this renderer. */
export function enqueueImeInput<T>(
  targetId: string,
  operation: (snapshot: ImeSessionSnapshot | undefined) => Promise<T>,
): Promise<T | undefined> {
  const result = inputQueue.then(async () => {
    if (!isActiveImeInputTarget(targetId)) return undefined;
    return operation(latestSnapshot);
  });
  inputQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function resetImeInputTargetCoordinatorForTests(): void {
  activeTarget = undefined;
  latestSnapshot = undefined;
  inputQueue = Promise.resolve();
}
