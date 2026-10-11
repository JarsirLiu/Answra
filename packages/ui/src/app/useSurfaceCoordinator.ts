import { type Dispatch, useReducer } from "react";
import {
  initialSurfaceState,
  type SurfaceAction,
  type SurfaceState,
  surfaceReducer,
} from "./surfaceState";

/**
 * 统一管理导航、二级面板、临时浮层和持续工作流的生命周期。
 * 页面组件只发出表面命令，不直接改 reducer，避免新功能绕过互斥与恢复规则。
 */
export function useSurfaceCoordinator() {
  const [state, dispatch] = useReducer(surfaceReducer, initialSurfaceState);

  return {
    ...state,
    dispatch,
    openPanel: (panel: SurfaceState["panel"]) => dispatch({ type: "panel/open", panel }),
    togglePanel: (panel: Exclude<SurfaceState["panel"], "closed">) =>
      dispatch({ type: "panel/toggle", panel }),
    openModeMenu: () => dispatch({ type: "layer/open", layer: "mode-menu" }),
    closeFloatingLayers: () => dispatch({ type: "layer/close" }),
    dismissFloatingLayer: (id: string) => dispatch({ type: "layer/dismiss", id }),
    startWorkflow: () => dispatch({ type: "workflow/start" }),
    finishWorkflow: () => dispatch({ type: "workflow/finish" }),
  } satisfies SurfaceState & {
    dispatch: Dispatch<SurfaceAction>;
    openPanel: (panel: SurfaceState["panel"]) => void;
    togglePanel: (panel: Exclude<SurfaceState["panel"], "closed">) => void;
    openModeMenu: () => void;
    closeFloatingLayers: () => void;
    dismissFloatingLayer: (id: string) => void;
    startWorkflow: () => void;
    finishWorkflow: () => void;
  };
}
