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

  it("enters the reply slot from the collapsed bar and restores it on exit, preserving restoreSlot across re-captures", () => {
    const entered = surfaceReducer(initialSurfaceState, {
      type: "feature/enter-reply",
      origin: "screenshot",
    });
    expect(entered.featureSlot).toEqual({
      kind: "reply",
      phase: "composing",
      restoreSlot: "chat",
      restorePanel: "closed",
      origin: "screenshot",
    });
    expect(entered.panel).toBe("chat");

    const recapture = surfaceReducer(entered, {
      type: "feature/enter-reply",
      origin: "screenshot",
    });
    expect(recapture.featureSlot.restoreSlot).toBe("chat");
    expect(recapture.featureSlot.restorePanel).toBe("closed");

    const streaming = surfaceReducer(recapture, { type: "feature/phase", phase: "streaming" });
    expect(streaming.featureSlot.phase).toBe("streaming");

    const exited = surfaceReducer(streaming, { type: "feature/exit-reply" });
    expect(exited.panel).toBe("closed");
    expect(exited.featureSlot).toEqual({
      kind: "chat",
      restoreSlot: "chat",
      restorePanel: "closed",
    });
  });

  it("restores the panel displaced when entering reply from a non-chat panel", () => {
    const withNotes = surfaceReducer(initialSurfaceState, {
      type: "panel/open",
      panel: "notes",
    });
    const entered = surfaceReducer(withNotes, {
      type: "feature/enter-reply",
      origin: "screenshot",
    });
    expect(entered.panel).toBe("chat");
    expect(entered.featureSlot.restorePanel).toBe("notes");

    const exited = surfaceReducer(entered, { type: "feature/exit-reply" });
    expect(exited.panel).toBe("notes");
    expect(exited.featureSlot.kind).toBe("chat");
  });

  it("ignores feature/phase when not in the reply slot", () => {
    const state = surfaceReducer(initialSurfaceState, {
      type: "feature/phase",
      phase: "streaming",
    });
    expect(state).toBe(initialSurfaceState);
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
