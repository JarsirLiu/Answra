import { type Dispatch, useCallback, useReducer } from "react";
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
  const openPanel = useCallback(
    (panel: SurfaceState["panel"]) => dispatch({ type: "panel/open", panel }),
    [],
  );
  const togglePanel = useCallback(
    (panel: Exclude<SurfaceState["panel"], "closed">) => dispatch({ type: "panel/toggle", panel }),
    [],
  );
  const openModeMenu = useCallback(() => dispatch({ type: "layer/open", layer: "mode-menu" }), []);
  const closeFloatingLayers = useCallback(() => dispatch({ type: "layer/close" }), []);
  const dismissFloatingLayer = useCallback(
    (id: string) => dispatch({ type: "layer/dismiss", id }),
    [],
  );
  const startWorkflow = useCallback(() => dispatch({ type: "workflow/start" }), []);
  const finishWorkflow = useCallback(() => dispatch({ type: "workflow/finish" }), []);

  return {
    ...state,
    dispatch,
    openPanel,
    togglePanel,
    openModeMenu,
    closeFloatingLayers,
    dismissFloatingLayer,
    startWorkflow,
    finishWorkflow,
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
