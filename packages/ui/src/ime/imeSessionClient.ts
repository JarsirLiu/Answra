import type {
  DesktopBridge,
  ImeSessionCommand,
  ImeSessionCommandResult,
  ImeSessionSnapshot,
} from "@answra/shared";

/**
 * Renderer-side session client: the single owner of the latest main-published snapshot,
 * the authoritative revision used for optimistic-concurrency, and the typed command
 * envelope (commandId + stale-revision retry).
 *
 * Focus, target leasing and the renderer input FIFO live in `imeInputTargetCoordinator`;
 * editor text/selection lives in the editor adapters. This module only speaks the
 * main-owned session protocol.
 */

let latestSnapshot: ImeSessionSnapshot | undefined;
let currentRevision = 0;

export function publishImeSessionSnapshot(snapshot: ImeSessionSnapshot): void {
  if (latestSnapshot && snapshot.revision < latestSnapshot.revision) return;
  latestSnapshot = snapshot;
  currentRevision = snapshot.revision;
}

export function getLatestImeSessionSnapshot(): ImeSessionSnapshot | undefined {
  return latestSnapshot;
}

export function getImeSessionRevision(): number {
  return currentRevision;
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
}
