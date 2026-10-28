import { IME_RENDERER_DIAGNOSTIC_EVENTS } from "@answra/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logImeDiagnostic, SUPPRESSED_IME_DIAGNOSTIC_EVENTS } from "../src/main/ime/imeDiagnostics";

describe("IME console diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints key results as one line with composition and candidate text", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logImeDiagnostic("key-processed", {
      generation: 2,
      key: "i",
      handled: true,
      composing: true,
      preedit: "ni",
      candidates: [{ text: "你", comment: "代词" }],
    });

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toContain('"candidates":"你"');
    expect(String(info.mock.calls[0]?.[0])).not.toContain("\n");
  });

  it("prints candidate DOM visibility and dimensions without object dumps", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logImeDiagnostic("candidate-rendered", {
      generation: 2,
      preedit: "ni",
      candidates: [{ text: "你" }],
      documentVisibility: "visible",
      candidateRoot: { rect: { x: 0, y: 0, width: 392, height: 60 } },
      candidatePopup: {
        rect: { x: 8, y: 8, width: 376, height: 44 },
        display: "flex",
        visibility: "visible",
        opacity: "1",
      },
    });

    expect(info.mock.calls[0]?.[0]).toContain('"visibility":"visible"');
    expect(info.mock.calls[0]?.[0]).toContain('"width":392');
    expect(String(info.mock.calls[0]?.[0])).not.toContain("\n");
  });

  it("logs candidate changes even when the rendered geometry is unchanged", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const layout = {
      generation: 28028,
      documentVisibility: "visible",
      documentHasFocus: false,
      candidateRoot: { rect: { x: 0, y: 0, width: 392, height: 60 } },
      candidatePopup: {
        rect: { x: 8, y: 8, width: 376, height: 44 },
        display: "flex",
        visibility: "visible",
        opacity: "1",
      },
    };

    logImeDiagnostic("candidate-rendered", {
      ...layout,
      targetId: "ime-candidate-window",
      preedit: "ni",
      candidates: [{ text: "你" }],
      selectedIndex: 0,
      page: 0,
    });
    logImeDiagnostic("candidate-rendered", {
      ...layout,
      targetId: "ime-candidate-window",
      preedit: "hao",
      candidates: [{ text: "好" }],
      selectedIndex: 0,
      page: 0,
    });

    expect(info).toHaveBeenCalledTimes(2);
    expect(String(info.mock.calls[0]?.[0])).toContain('"candidates":"你"');
    expect(String(info.mock.calls[1]?.[0])).toContain('"preedit":"hao"');
    expect(String(info.mock.calls[1]?.[0])).toContain('"candidates":"好"');
  });

  it("suppresses an unchanged candidate presentation", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const presentation = {
      targetId: "ime-candidate-window",
      generation: 28029,
      preedit: "ni",
      candidates: [{ text: "你" }],
      selectedIndex: 0,
      page: 0,
      documentVisibility: "visible",
      candidateRoot: { rect: { x: 0, y: 0, width: 392, height: 60 } },
      candidatePopup: {
        rect: { x: 8, y: 8, width: 376, height: 44 },
        display: "flex",
        visibility: "visible",
        opacity: "1",
      },
    };

    logImeDiagnostic("candidate-rendered", presentation);
    logImeDiagnostic("candidate-rendered", presentation);

    expect(info).toHaveBeenCalledOnce();
  });

  it("prints native candidate placement with owner and anchor geometry", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logImeDiagnostic("candidate-native-positioned", {
      windowId: 2,
      ownerWindowId: 1,
      targetId: "chat-composer",
      generation: 3,
      nativeHandle: "0xabc",
      bounds: { x: 500, y: 400, width: 392, height: 60 },
      anchor: { x: 508, lineTop: 384, lineBottom: 402 },
      ownerContentBounds: { x: 470, y: 12, width: 400, height: 456 },
      visible: true,
    });

    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]?.[0])).toContain('"ownerWindowId":1');
    expect(String(info.mock.calls[0]?.[0])).toContain('"lineBottom":402');
    expect(String(info.mock.calls[0]?.[0])).not.toContain("\n");
  });

  it("keeps the focus chain visible without ANSWRA_IME_DEBUG", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logImeDiagnostic("renderer-input-focus", {
      windowId: 1,
      targetId: "main-composer",
      activeElementTarget: true,
    });
    logImeDiagnostic("renderer-input-blur", { windowId: 1, targetId: "main-composer" });
    logImeDiagnostic("renderer-window-focus", { windowId: 1, targetId: "main-composer" });
    logImeDiagnostic("renderer-window-blur", { windowId: 1, targetId: "main-composer" });
    logImeDiagnostic("renderer-input-mounted", { windowId: 1, targetId: "main-composer" });

    expect(info).toHaveBeenCalledTimes(4);
    expect(String(info.mock.calls[0]?.[0])).toContain("renderer-input-focus");
  });

  it("only suppresses renderer events that really exist in the shared list", () => {
    const suppressed: readonly string[] = SUPPRESSED_IME_DIAGNOSTIC_EVENTS;
    const rendererEvents = suppressed.filter((event) => event.startsWith("renderer-"));

    expect(rendererEvents.length).toBeGreaterThan(0);
    for (const event of rendererEvents) {
      const name = event.slice("renderer-".length);
      expect(IME_RENDERER_DIAGNOSTIC_EVENTS).toContain(name as never);
    }
    for (const visible of ["renderer-input-focus", "renderer-input-blur"]) {
      expect(suppressed).not.toContain(visible);
    }
  });

  it("prints unclipped and requested candidate sizes before the window is visible", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logImeDiagnostic("candidate-native-positioned", {
      windowId: 2,
      targetId: "chat-composer",
      generation: 4,
      bounds: { x: 500, y: 400, width: 160, height: 52 },
      requestedSize: { width: 472, height: 72 },
      candidateBounds: { x: 500, y: 400, width: 472, height: 72 },
      visible: false,
    });

    expect(info).toHaveBeenCalledOnce();
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toContain('"requestedSize":{"width":472,"height":72}');
    expect(line).toContain('"candidateBounds"');
  });

  it("suppresses redundant per-key routing and state-transfer events", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logImeDiagnostic("renderer-key-routing", { key: "n", accepted: true });
    logImeDiagnostic("candidate-state-sent", { preedit: "n" });
    logImeDiagnostic("candidate-state-received", { preedit: "n" });

    expect(info).not.toHaveBeenCalled();
  });

  it("prints shortcut routing with selection metadata as one line", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logImeDiagnostic("key-routing", {
      key: "a",
      ctrl: true,
      composing: true,
      accepted: true,
      selectionStart: 0,
      selectionEnd: 13,
      selectionLength: 13,
      valueLength: 13,
    });

    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]?.[0])).toContain('"imeConsumed":true');
    expect(String(info.mock.calls[0]?.[0])).not.toContain("\n");
  });

  it("suppresses routine candidate positioning statuses but keeps readiness failures", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logImeDiagnostic("candidate-position-status", { status: "show-request-visible" });
    logImeDiagnostic("candidate-position-status", { status: "already-visible" });
    logImeDiagnostic("candidate-position-status", { status: "owner-unavailable" });

    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]?.[0])).toContain("owner-unavailable");
  });

  it("keeps composition transitions and shortcut failures while suppressing ordinary pinyin keys", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const base = {
      windowId: 1,
      generation: 9400,
      handled: true,
      composing: true,
      preedit: "ni",
      candidates: [{ text: "你" }],
    };

    logImeDiagnostic("key-processed", { ...base, key: "n", preedit: "n" });
    logImeDiagnostic("key-processed", { ...base, key: "i" });
    logImeDiagnostic("key-processed", {
      ...base,
      key: "a",
      ctrl: true,
      handled: false,
    });

    expect(info).toHaveBeenCalledTimes(2);
    expect(String(info.mock.calls[0]?.[0])).toContain('"preedit":"n"');
    expect(String(info.mock.calls[1]?.[0])).toContain('"ctrl":true');
    logImeDiagnostic("lease-released", { windowId: 1, generation: 9400 });
  });
});
