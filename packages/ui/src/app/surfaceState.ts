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

/**
 * 功能槽种类。`chat` 渲染对话消息流，`reply` 渲染就地回复条（发送条 + 回复条）。
 * 与 `panel` 正交：`panel` 决定外壳，`featureSlot` 决定该外壳内主区域内容。
 */
export type FeatureSlotKind = "chat" | "reply";

export interface FeatureSlot {
  kind: FeatureSlotKind;
  /** 仅 reply slot 使用：回复条当前阶段。 */
  phase?: ReplyPhase;
  /** 退出 reply slot 时回到哪个 slot。 */
  restoreSlot: FeatureSlotKind;
  /** 进入 reply slot 时记录的 panel，退出时恢复（reply 必须在 chat panel 内渲染）。 */
  restorePanel: Panel;
  /** 进入 reply slot 的触发来源，用于截图取消判断等。 */
  origin?: "screenshot" | "manual";
}

export interface SurfaceState {
  panel: Panel;
  layer: FloatingLayer;
  featureSlot: FeatureSlot;
  /** 旧工作流形态，保留为独立回复窗口过渡兼容；主窗口内联只走 `feature/*`。 */
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
  | { type: "feature/enter-reply"; origin: "screenshot" | "manual" }
  | { type: "feature/exit-reply" }
  | { type: "feature/phase"; phase: ReplyPhase }
  | { type: "layer/show-notice"; id: string; message: string; closePolicy?: "auto" | "explicit" }
  | { type: "layer/show-permission"; layer: Extract<FloatingHostLayer, { kind: "permission" }> }
  | { type: "layer/dismiss"; id: string };

export const initialSurfaceState: SurfaceState = {
  panel: "closed",
  layer: "closed",
  featureSlot: { kind: "chat", restoreSlot: "chat", restorePanel: "chat" },
  workflow: null,
  floatingLayers: [],
};

/**
 * Coordinates visible surfaces only. Panel content and workflow drafts remain owned by the app;
 * a workflow temporarily owns the content slot and restores the panel it displaced when finished.
 * `featureSlot` is orthogonal to `panel`: it swaps the main area inside a panel shell without
 * closing the panel. All feature-slot transitions go through here so exclusivity and restore stay centralized.
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
    case "feature/enter-reply":
      return {
        ...state,
        layer: "closed",
        panel: "chat",
        featureSlot: {
          kind: "reply",
          phase: "composing",
          restoreSlot:
            state.featureSlot.kind === "reply"
              ? state.featureSlot.restoreSlot
              : state.featureSlot.kind,
          restorePanel:
            state.featureSlot.kind === "reply" ? state.featureSlot.restorePanel : state.panel,
          origin: action.origin,
        },
      };
    case "feature/exit-reply": {
      const restoreSlot = state.featureSlot.restoreSlot;
      const restorePanel = state.featureSlot.restorePanel;
      return {
        ...state,
        panel: restorePanel,
        featureSlot: { kind: restoreSlot, restoreSlot, restorePanel },
      };
    }
    case "feature/phase":
      return state.featureSlot.kind === "reply"
        ? { ...state, featureSlot: { ...state.featureSlot, phase: action.phase } }
        : state;
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
