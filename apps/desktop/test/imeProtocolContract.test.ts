import { ImeChannels } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";

/**
 * Cross-module contract lock for the IME protocol surface.
 *
 * These assertions do not exercise routing behaviour; they freeze the shape every
 * process depends on, so the decoupling cannot silently regress:
 * - the exact channel set and wire names (a rename breaks a live main/renderer pair);
 * - the preload exposing exactly one IME session entry point and no legacy `ime*` methods.
 *
 * Note: `apps/desktop/test` is not covered by any `tsc` project, so these must be
 * runtime assertions — a type-level `expectTypeOf` would never be checked in CI.
 */
const exposed = vi.hoisted(() => ({
  globalName: undefined as string | undefined,
  api: undefined as Record<string, unknown> | undefined,
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
      exposed.globalName = name;
      exposed.api = api;
    },
  },
  ipcRenderer: {
    invoke: exposed.invoke,
    send: exposed.send,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import "../src/preload/index";

describe("IME protocol surface contract", () => {
  it("declares exactly the session channels with stable wire names", () => {
    expect(ImeChannels).toEqual({
      Diagnostic: "answra:ime:diagnostic",
      SessionCommand: "answra:ime:session-command",
      SessionSnapshot: "answra:ime:session-snapshot",
    });
  });

  it("exposes the renderer bridge under one global with a single IME session entry point", () => {
    expect(exposed.globalName).toBe("answra");
    const api = exposed.api;
    if (!api) throw new Error("expected the preload to expose window.answra");

    const imeKeys = Object.keys(api)
      .filter((key) => key.startsWith("ime"))
      .sort();
    expect(imeKeys).toEqual(["imeAvailable", "imeDiagnostic", "imeSessionCommand"]);

    const legacy = Object.keys(api).filter((key) =>
      /^ime(Acquire|Release|ConfirmFocus|Key|Select|Reset|Change)$/.test(key),
    );
    expect(legacy).toEqual([]);

    expect(typeof api.getImeSessionSnapshot).toBe("function");
    expect(typeof api.onImeSessionSnapshot).toBe("function");
  });

  it("routes the single session entry point through the typed session channel", async () => {
    const api = exposed.api as { imeSessionCommand: (command: unknown) => Promise<unknown> };

    await api.imeSessionCommand({ type: "reset" });

    expect(exposed.invoke).toHaveBeenCalledWith(ImeChannels.SessionCommand, { type: "reset" });
  });
});
