import type { ReplyPhase } from "../components/panels/ReplyBar";
import type { Panel } from "../model";

export type FloatingLayer = "closed" | "mode-menu";

export type FloatingHostLayer =
  | { kind: "notice"; id: string; message: string; closePolicy: "auto" | "explicit" }
  | {
      kind: "permission";
      id: string;
      title: string;
      description: string;
      confirmLabel: string;
      cancelLabel: string;
    };

export interface SurfaceState {
  panel: Panel;
  layer: FloatingLayer;
  workflow: { kind: "screenshot-reply"; phase: ReplyPhase; restorePanel: Panel } | null;
  floatingLayers: FloatingHostLayer[];
}

export type SurfaceAction =
  | { type: "panel/open"; panel: Panel }
  | { type: "panel/toggle"; panel: Exclude<Panel, "closed"> }
  | { type: "layer/open"; layer: Exclude<FloatingLayer, "closed"> }
  | { type: "layer/close" }
  | { type: "workflow/start" }
  | { type: "workflow/phase"; phase: ReplyPhase }
  | { type: "workflow/finish" }
  | { type: "layer/show-notice"; id: string; message: string; closePolicy?: "auto" | "explicit" }
  | { type: "layer/show-permission"; layer: Extract<FloatingHostLayer, { kind: "permission" }> }
  | { type: "layer/dismiss"; id: string };

export const initialSurfaceState: SurfaceState = {
  panel: "closed",
  layer: "closed",
  workflow: null,
  floatingLayers: [],
};

/**
 * Coordinates visible surfaces only. Panel content and workflow drafts remain owned by the app;
 * a workflow temporarily owns the content slot and restores the panel it displaced when finished.
 */
export function surfaceReducer(state: SurfaceState, action: SurfaceAction): SurfaceState {
  switch (action.type) {
    case "panel/open":
      return { ...state, panel: action.panel };
    case "panel/toggle":
      return { ...state, panel: state.panel === action.panel ? "closed" : action.panel };
    case "layer/open":
      return { ...state, layer: action.layer };
    case "layer/close":
      return { ...state, layer: "closed" };
    case "workflow/start":
      return {
        ...state,
        layer: "closed",
        panel: "closed",
        workflow: {
          kind: "screenshot-reply",
          phase: "composing",
          restorePanel: state.workflow?.restorePanel ?? state.panel,
        },
      };
    case "workflow/phase":
      return state.workflow
        ? { ...state, workflow: { ...state.workflow, phase: action.phase } }
        : state;
    case "workflow/finish":
      return {
        ...state,
        panel: state.workflow?.restorePanel ?? state.panel,
        workflow: null,
      };
    case "layer/show-notice":
      return {
        ...state,
        floatingLayers: [
          ...state.floatingLayers.filter((layer) => layer.id !== action.id),
          {
            kind: "notice",
            id: action.id,
            message: action.message,
            closePolicy: action.closePolicy ?? "auto",
          },
        ],
      };
    case "layer/show-permission":
      return {
        ...state,
        floatingLayers: [
          ...state.floatingLayers.filter((layer) => layer.id !== action.layer.id),
          action.layer,
        ],
      };
    case "layer/dismiss":
      return {
        ...state,
        floatingLayers: state.floatingLayers.filter((layer) => layer.id !== action.id),
      };
  }
}
