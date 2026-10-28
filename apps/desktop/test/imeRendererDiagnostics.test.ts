import { describe, expect, it, vi } from "vitest";
import { createImeRendererDiagnosticHandler } from "../src/main/ime/imeRendererDiagnostics";

const owner = { id: 1, webContents: { id: 11 } };
const candidate = { id: 3, webContents: { id: 33 } };

describe("IME renderer diagnostic ingress", () => {
  it("authenticates the sender, filters targets, and logs only approved fields", () => {
    const log = vi.fn();
    const handle = createImeRendererDiagnosticHandler({
      isCandidateWindowFromSender: (event) => event.sender.id === 33,
      getCandidateWindow: () => candidate,
      getOwnerWindow: (event) => (event.sender.id === 11 ? owner : undefined),
      isDebugEnabled: () => false,
      log,
    });

    handle({ sender: { id: 11 } } as Electron.IpcMainEvent, {
      event: "input-focus",
      targetId: "main-composer",
      activeElementTarget: false,
      typedText: "private content must not be projected",
    });
    handle({ sender: { id: 99 } } as Electron.IpcMainEvent, {
      event: "input-focus",
      targetId: "main-composer",
    });
    handle({ sender: { id: 11 } } as Electron.IpcMainEvent, {
      event: "input-focus",
      targetId: "unregistered-target",
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("renderer-input-focus", {
      windowId: 1,
      webContentsId: 11,
      targetId: "main-composer",
      activeElementTarget: false,
    });
  });

  it("keeps ordinary text key-routing diagnostics suppressed outside debug mode", () => {
    const log = vi.fn();
    const handle = createImeRendererDiagnosticHandler({
      isCandidateWindowFromSender: () => false,
      getCandidateWindow: () => undefined,
      getOwnerWindow: () => owner,
      isDebugEnabled: () => false,
      log,
    });

    handle({ sender: { id: 11 } } as Electron.IpcMainEvent, {
      event: "key-routing",
      targetId: "main-composer",
      key: "n",
      keyKind: "text",
    });
    handle({ sender: { id: 11 } } as Electron.IpcMainEvent, {
      event: "key-routing",
      targetId: "main-composer",
      key: "Backspace",
      keyKind: "backspace",
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "key-routing",
      expect.objectContaining({ key: "Backspace", keyKind: "backspace" }),
    );
  });

  it("accepts candidate render reports only from the candidate sender", () => {
    const log = vi.fn();
    const handle = createImeRendererDiagnosticHandler({
      isCandidateWindowFromSender: (event) => event.sender.id === 33,
      getCandidateWindow: () => candidate,
      getOwnerWindow: () => owner,
      isDebugEnabled: () => false,
      log,
    });
    const payload = {
      event: "candidate-rendered",
      targetId: "ime-candidate-window",
      ownerTargetId: "chat-composer",
      generation: 2,
      candidates: [{ text: "你" }],
    };

    handle({ sender: { id: 11 } } as Electron.IpcMainEvent, payload);
    handle({ sender: { id: 33 } } as Electron.IpcMainEvent, payload);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "candidate-rendered",
      expect.objectContaining({ windowId: 3, webContentsId: 33, generation: 2 }),
    );
  });
});
