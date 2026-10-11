import { describe, expect, it } from "vitest";
import { initialSurfaceState, surfaceReducer } from "../src/app/surfaceState";

describe("surface coordinator", () => {
  it("keeps the panel slot independent from dismissible floating layers", () => {
    const withPanel = surfaceReducer(initialSurfaceState, {
      type: "panel/open",
      panel: "settings",
    });
    const withMenu = surfaceReducer(withPanel, { type: "layer/open", layer: "mode-menu" });

    expect(withMenu.panel).toBe("settings");
    expect(surfaceReducer(withMenu, { type: "layer/close" })).toMatchObject({
      panel: "settings",
      layer: "closed",
    });
  });

  it("restores the displaced panel after a screenshot workflow, including added screenshots", () => {
    const withPanel = surfaceReducer(initialSurfaceState, {
      type: "panel/open",
      panel: "notes",
    });
    const workflow = surfaceReducer(withPanel, { type: "workflow/start" });
    const secondCapture = surfaceReducer(workflow, { type: "workflow/start" });
    const streaming = surfaceReducer(secondCapture, {
      type: "workflow/phase",
      phase: "streaming",
    });

    expect(workflow.panel).toBe("closed");
    expect(streaming.workflow?.phase).toBe("streaming");
    expect(surfaceReducer(streaming, { type: "workflow/finish" })).toMatchObject({
      panel: "notes",
      workflow: null,
    });
  });

  it("keeps permission prompts in the floating host until an explicit dismissal", () => {
    const prompt = {
      kind: "permission" as const,
      id: "screen-access",
      title: "屏幕访问权限",
      description: "需要屏幕录制权限以启动会议捕获。",
      confirmLabel: "打开系统设置",
      cancelLabel: "暂不处理",
    };
    const withPrompt = surfaceReducer(initialSurfaceState, {
      type: "layer/show-permission",
      layer: prompt,
    });

    expect(withPrompt.floatingLayers).toEqual([prompt]);
    expect(
      surfaceReducer(withPrompt, { type: "layer/dismiss", id: prompt.id }).floatingLayers,
    ).toEqual([]);
  });
});
