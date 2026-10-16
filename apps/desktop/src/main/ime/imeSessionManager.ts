import type { ImeKeyRequest, ImeSessionSnapshot, ImeState } from "@answra/shared";
import {
  type ImeSessionEvent,
  type ImeSessionState,
  initialImeSessionState,
  reduceImeSession,
} from "./imeSessionState";
import type { RimeBridge } from "./rimeBridge";

/** Owns the main-process Rime session, lease state, revision and command queue. */
export class ImeSessionManager {
  private leaseState: ImeSessionState = { ...initialImeSessionState };
  private queue: Promise<unknown> = Promise.resolve();
  private engineStarted = false;
  private revision = 0;
  private lastEngineState: ImeState;

  constructor(private readonly engine: RimeBridge) {
    this.lastEngineState = engine.snapshot;
  }

  get lease(): ImeSessionState {
    return this.leaseState;
  }

  get engineState(): ImeState {
    return this.trackEngineState(this.engine.snapshot);
  }

  get snapshot(): ImeSessionSnapshot {
    const state = this.engineState;
    const lease = this.leaseState;
    const active = lease.status === "owned" || lease.status === "suspended";
    return {
      phase: lease.status,
      ...(active
        ? {
            owner: {
              ...lease.owner,
              generation: lease.generation,
            },
          }
        : {}),
      engine: {
        enabled: state.enabled,
        inputMode: state.inputMode,
        composing: state.composing,
        preedit: state.preedit,
        candidates: state.candidates,
        selectedIndex: state.selectedIndex,
        page: state.page,
        hasNextPage: state.hasNextPage,
      },
      revision: this.revision,
    };
  }

  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  transition(event: ImeSessionEvent): ImeSessionState {
    const previous = this.leaseState;
    this.leaseState = reduceImeSession(this.leaseState, event);
    if (!sameLeaseState(previous, this.leaseState)) this.revision += 1;
    return this.leaseState;
  }

  async enableEngine(): Promise<ImeState> {
    if (this.engineStarted) return this.engine.snapshot;
    const state = await this.engine.enable(true);
    this.engineStarted = state.enabled;
    this.trackEngineState(state);
    return state;
  }

  async processKey(request: ImeKeyRequest): Promise<ImeState> {
    return this.trackEngineState(await this.engine.key(request));
  }

  async selectCandidate(index: number): Promise<ImeState> {
    return this.trackEngineState(await this.engine.select(index));
  }

  async resetComposition(): Promise<ImeState> {
    return this.trackEngineState(await this.engine.reset());
  }

  dispose(): void {
    this.transition({ type: "dispose" });
    this.engine.dispose();
  }

  private trackEngineState(state: ImeState): ImeState {
    if (!sameEngineState(this.lastEngineState, state)) {
      this.revision += 1;
      this.lastEngineState = state;
    }
    return state;
  }
}

function sameEngineState(left: ImeState, right: ImeState): boolean {
  return (
    left.enabled === right.enabled &&
    left.inputMode === right.inputMode &&
    left.composing === right.composing &&
    left.preedit === right.preedit &&
    left.selectedIndex === right.selectedIndex &&
    left.page === right.page &&
    left.hasNextPage === right.hasNextPage &&
    JSON.stringify(left.candidates) === JSON.stringify(right.candidates)
  );
}

function sameLeaseState(left: ImeSessionState, right: ImeSessionState): boolean {
  if (left.status !== right.status || left.generation !== right.generation) return false;
  if (!isActiveImeLease(left) || !isActiveImeLease(right)) return true;
  return (
    left.owner.windowId === right.owner.windowId &&
    left.owner.webContentsId === right.owner.webContentsId &&
    left.owner.targetId === right.owner.targetId
  );
}

export function isActiveImeLease(
  state: ImeSessionState,
): state is Extract<ImeSessionState, { status: "owned" | "suspended" }> {
  return state.status === "owned" || state.status === "suspended";
}
