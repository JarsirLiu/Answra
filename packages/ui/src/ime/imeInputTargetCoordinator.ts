interface ActiveTarget {
  id: string;
  deactivate: () => void;
}

let activeTarget: ActiveTarget | undefined;

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

export function resetImeInputTargetCoordinatorForTests(): void {
  activeTarget = undefined;
}
