import type {
  DesktopBridge,
  ImeInputMode,
  ImeSessionCommand,
  ImeSessionCommandResult,
  ImeSessionSnapshot,
} from "@answra/shared";
import type { ImeEngineState } from "./imeKeyRouter";

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
export function selectImeOwnedGeneration(
  snapshot: ImeSessionSnapshot | undefined,
  targetId: string,
): number | undefined {
  const owner = snapshot?.owner;
  return owner && owner.targetId === targetId ? owner.generation : undefined;
}

export function getImeOwnedGeneration(targetId: string): number | undefined {
  return selectImeOwnedGeneration(latestSnapshot, targetId);
}

/**
 * The engine facts a key route reads. This is the single projection of
 * `snapshot.engine` into the router's input: callers must not assemble the fields
 * from the two separate getters below, or the routing decision gains a second source.
 */
export function selectImeEngineState(snapshot: ImeSessionSnapshot | undefined): ImeEngineState {
  return {
    inputMode: snapshot?.engine.inputMode ?? "chinese",
    composing: snapshot?.engine.composing === true,
  };
}

/** Engine mode is session-wide, not per target, and always comes from main. */
export function getImeInputMode(): ImeInputMode {
  return selectImeEngineState(latestSnapshot).inputMode;
}

export function getImeComposing(): boolean {
  return selectImeEngineState(latestSnapshot).composing;
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
