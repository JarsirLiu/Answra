export interface ImeOwnerIdentity {
  windowId: number;
  webContentsId: number;
  targetId: string;
}

export type ImeSessionState =
  | { status: "idle"; generation: number }
  | { status: "owned"; owner: ImeOwnerIdentity; generation: number }
  | { status: "suspended"; owner: ImeOwnerIdentity; generation: number }
  | { status: "unavailable"; generation: number }
  | { status: "disposed"; generation: number };

export type ImeSessionEvent =
  | { type: "acquire"; owner: ImeOwnerIdentity }
  | { type: "confirm-focus"; owner: ImeOwnerIdentity; generation: number }
  | { type: "suspend"; owner: ImeOwnerIdentity; generation: number }
  | { type: "release"; owner: ImeOwnerIdentity; generation: number }
  | { type: "owner-destroyed"; windowId: number; webContentsId?: number }
  | { type: "unavailable" }
  | { type: "dispose" };

export const initialImeSessionState: ImeSessionState = { status: "idle", generation: 0 };

/** Pure lease transitions. IPC and Rime side effects belong to the manager. */
export function reduceImeSession(state: ImeSessionState, event: ImeSessionEvent): ImeSessionState {
  if (state.status === "disposed") return state;

  if (event.type === "dispose") return { status: "disposed", generation: state.generation + 1 };
  if (event.type === "unavailable")
    return { status: "unavailable", generation: state.generation + 1 };
  if (event.type === "acquire") {
    if (state.status === "unavailable") return state;
    return {
      status: "owned",
      owner: event.owner,
      generation: state.generation + 1,
    };
  }
  if (state.status !== "owned" && state.status !== "suspended") return state;

  if (event.type === "confirm-focus" && matchesLease(state, event)) {
    return { ...state, status: "owned" };
  }
  if (event.type === "suspend" && matchesLease(state, event)) {
    return { ...state, status: "suspended" };
  }
  if (event.type === "release" && matchesLease(state, event)) {
    return { status: "idle", generation: state.generation };
  }
  if (
    event.type === "owner-destroyed" &&
    state.owner.windowId === event.windowId &&
    (event.webContentsId === undefined || state.owner.webContentsId === event.webContentsId)
  ) {
    return { status: "idle", generation: state.generation + 1 };
  }
  return state;
}

function matchesLease(
  state: Extract<ImeSessionState, { status: "owned" | "suspended" }>,
  event: { owner: ImeOwnerIdentity; generation: number },
): boolean {
  return state.generation === event.generation && sameOwner(state.owner, event.owner);
}

function sameOwner(left: ImeOwnerIdentity, right: ImeOwnerIdentity): boolean {
  return (
    left.windowId === right.windowId &&
    left.webContentsId === right.webContentsId &&
    left.targetId === right.targetId
  );
}
