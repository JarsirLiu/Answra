import { afterEach, describe, expect, it, vi } from "vitest";
import { logImeDiagnostic } from "../src/main/ime/imeDiagnostics";

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
