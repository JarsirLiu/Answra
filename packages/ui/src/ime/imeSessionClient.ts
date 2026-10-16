import type {
  DesktopBridge,
  ImeInputMode,
  ImeSessionCommand,
  ImeSessionCommandResult,
  ImeSessionSnapshot,
} from "@answra/shared";

/**
 * Renderer-side session client: the single owner of the latest main-published snapshot,
 * the authoritative revision used for optimistic-concurrency, and the typed command
 * envelope (commandId + stale-revision retry).
 *
 * Every renderer fact derived from the session (ownership, generation, input mode,
 * composition) must be read from here instead of being copied into component or hook
 * state. Focus, target leasing and the renderer input FIFO live in
 * `imeInputTargetCoordinator`; editor text/selection lives in the editor adapters.
 * This module only speaks the main-owned session protocol.
 */

let latestSnapshot: ImeSessionSnapshot | undefined;
let currentRevision = 0;
const listeners = new Set<() => void>();

export function publishImeSessionSnapshot(snapshot: ImeSessionSnapshot): void {
  if (latestSnapshot && snapshot.revision < latestSnapshot.revision) return;
  latestSnapshot = snapshot;
  currentRevision = snapshot.revision;
  for (const listener of listeners) listener();
}

/** Subscribes to snapshot publications; used by hooks to re-render on session changes. */
export function subscribeImeSessionSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLatestImeSessionSnapshot(): ImeSessionSnapshot | undefined {
  return latestSnapshot;
}

/** Generation currently owned by `targetId`; undefined once another target holds it. */
export function getImeOwnedGeneration(targetId: string): number | undefined {
  const owner = latestSnapshot?.owner;
  return owner && owner.targetId === targetId ? owner.generation : undefined;
}

/** True only while main reports this target as the owner of an active lease. */
export function isImeTargetOwned(targetId: string): boolean {
  return latestSnapshot?.phase === "owned" && latestSnapshot.owner?.targetId === targetId;
}

/** Engine mode is session-wide, not per target, and always comes from main. */
export function getImeInputMode(): ImeInputMode {
  return latestSnapshot?.engine.inputMode ?? "chinese";
}

export function getImeComposing(): boolean {
  return latestSnapshot?.engine.composing === true;
}

/**
 * Sends one typed session command with a unique commandId. A `stale-revision` rejection
 * is retried exactly once after adopting the returned snapshot, so the queue never loops.
 */
export async function sendImeSessionCommand(
  bridge: DesktopBridge | undefined,
  input: Omit<ImeSessionCommand, "commandId" | "expectedRevision">,
): Promise<ImeSessionCommandResult | undefined> {
  const command = bridge?.imeSessionCommand;
  if (!command) return undefined;
  const send = () =>
    command({
      ...input,
      commandId: globalThis.crypto.randomUUID(),
      expectedRevision: currentRevision,
    } as ImeSessionCommand);
  let result = await send();
  if (result.reason === "stale-revision") {
    publishImeSessionSnapshot(result.snapshot);
    result = await send();
  }
  publishImeSessionSnapshot(result.snapshot);
  return result;
}

export function resetImeSessionClientForTests(): void {
  latestSnapshot = undefined;
  currentRevision = 0;
  listeners.clear();
}
