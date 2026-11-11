import {
  parseSurfaceSpec,
  SURFACE_LIMITS,
  type SurfaceActionEvent,
  type SurfacePresetId,
} from "@answra/shared";
import { getSurfacePreset } from "./surfacePresets";
import {
  createSurfaceWindowController,
  type SurfaceWindowControllerHost,
} from "./surfaceWindowController";

export interface SurfaceServiceHost extends SurfaceWindowControllerHost {
  forwardAction: (event: SurfaceActionEvent) => void;
  log?: (message: string, details?: unknown) => void;
}

/** 产品预设的解析、校验、展示与动作回传；Agent 接入前先只服务产品代码。 */
export function createSurfaceService(host: SurfaceServiceHost) {
  const controller = createSurfaceWindowController(host);
  const log = host.log ?? ((message, details) => console.warn(message, details));
  let revision = 0;

  function showPreset(presetId: SurfacePresetId): { shown: boolean } {
    const preset = getSurfacePreset(presetId);
    if (!preset) {
      log("[surface] unknown preset", { presetId });
      return { shown: false };
    }
    const candidate = { ...preset, revision: ++revision };
    const validated = parseSurfaceSpec(candidate);
    if (!validated.ok) {
      log("[surface] invalid preset spec", { presetId, issues: validated.issues });
      return { shown: false };
    }
    if (Buffer.byteLength(JSON.stringify(validated.spec), "utf8") > SURFACE_LIMITS.maxSpecBytes) {
      log("[surface] preset spec exceeds byte limit", { presetId });
      return { shown: false };
    }
    controller.show(validated.spec);
    return { shown: true };
  }

  function handleAction(actionId: string): void {
    const state = controller.getState();
    if (!state) return;
    const action = state.spec.actions?.[actionId];
    if (!action) {
      log("[surface] unknown action", { actionId, surfaceId: state.spec.id });
      return;
    }
    const event: SurfaceActionEvent = {
      surfaceId: state.spec.id,
      ...(state.spec.presetId === undefined ? {} : { presetId: state.spec.presetId }),
      actionId,
      action,
    };
    if (action.type === "dismiss") {
      controller.dismiss();
      return;
    }
    // 首版所有非关闭动作都先收起浮窗，再交给产品代码执行。
    controller.dismiss();
    host.forwardAction(event);
  }

  return {
    ...controller,
    handleAction,
    showPreset,
  };
}
