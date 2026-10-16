import type {
  DesktopBridge,
  ImeCandidateAction,
  ImeSessionCommand,
  ImeSessionSnapshot,
  ImeState,
} from "@answra/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEmbeddedIme } from "../src/hooks/useEmbeddedIme";
import {
  applyControlledTextCommand,
  replaceTextRange,
} from "../src/ime/adapters/controlledTextAdapter";
import { resetImeInputTargetCoordinatorForTests } from "../src/ime/imeInputTargetCoordinator";

const emptyState: ImeState = {
  enabled: true,
  inputMode: "chinese",
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

describe("renderer IME input transaction", () => {
  beforeEach(() => resetImeInputTargetCoordinatorForTests());

  it("drops queued old-target input and ignores its late result during a lease switch", async () => {
    const trace: string[] = [];
    let state = emptyState;
    let revision = 0;
    let owner: ImeSessionSnapshot["owner"];
    let resolveFirstKey: ((result: ImeSessionSnapshot) => void) | undefined;
    const firstKey = new Promise<ImeSessionSnapshot>((resolve) => {
      resolveFirstKey = resolve;
    });
    const snapshot = (): ImeSessionSnapshot => ({
      phase: owner ? "owned" : "idle",
      ...(owner ? { owner } : {}),
      engine: state,
      revision,
    });
    let commandQueue = Promise.resolve();
    const imeSessionCommand = vi.fn((command: ImeSessionCommand) => {
      const result = commandQueue.then(async () => {
        if (command.type === "acquireTarget") {
          const generation = command.targetId === "first" ? 10 : 11;
          owner = {
            windowId: 1,
            webContentsId: 1,
            targetId: command.targetId,
            generation,
          };
          trace.push(`acquire:${command.targetId}`);
        } else if (command.type === "releaseTarget") {
          trace.push(`release:${command.targetId}`);
          if (owner?.generation === command.generation) {
            owner = undefined;
            state = { ...emptyState };
          }
        } else if (command.type === "processKey") {
          trace.push(`key:${command.targetId}:${command.key}`);
          if (command.key === "a") {
            const lateSnapshot = await firstKey;
            return {
              commandId: command.commandId,
              accepted: true,
              snapshot: lateSnapshot,
              commit: { text: "旧组合", revision: lateSnapshot.revision },
            };
          }
        }
        revision += 1;
        return { commandId: command.commandId, accepted: true, snapshot: snapshot() };
      });
      commandQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    const bridge = {
      imeAvailable: true,
      imeSessionCommand,
      getImeSessionSnapshot: async () => snapshot(),
      onImeSessionSnapshot: () => () => undefined,
    } as unknown as DesktopBridge;
    const firstCommit = vi.fn();
    const secondCommit = vi.fn();
    const firstHook = renderHook(() => useEmbeddedIme(bridge, firstCommit, true, "first"));
    const secondHook = renderHook(() => useEmbeddedIme(bridge, secondCommit, true, "second"));
    await act(async () => firstHook.result.current.acquire());

    const keyEvent = (key: string, code: string) => ({
      key,
      code,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
    });
    act(() => {
      firstHook.result.current.sendKey(keyEvent("a", "KeyA") as never);
      firstHook.result.current.sendKey(keyEvent("b", "KeyB") as never);
    });
    await waitFor(() => expect(trace).toContain("key:first:a"));

    let acquireSecond: Promise<void> | undefined;
    await act(async () => {
      acquireSecond = secondHook.result.current.acquire();
      await Promise.resolve();
    });
    expect(trace).toEqual(["acquire:first", "key:first:a"]);

    await act(async () => {
      revision += 1;
      resolveFirstKey?.(snapshot());
      await acquireSecond;
    });
    await waitFor(() => expect(secondHook.result.current.generation).toBe(11));
    act(() => secondHook.result.current.sendKey(keyEvent("c", "KeyC") as never));
    await waitFor(() => expect(trace).toContain("key:second:c"));

    expect(trace).toEqual([
      "acquire:first",
      "key:first:a",
      "release:first",
      "acquire:second",
      "key:second:c",
    ]);
    expect(firstCommit).not.toHaveBeenCalled();
    expect(secondCommit).not.toHaveBeenCalled();
    expect(imeSessionCommand.mock.calls.map(([command]) => command.type)).toEqual([
      "acquireTarget",
      "processKey",
      "releaseTarget",
      "acquireTarget",
      "processKey",
    ]);

    firstHook.unmount();
    secondHook.unmount();
  });

  it("serializes key and candidate actions, then applies commit and editor fallback once", async () => {
    const trace: string[] = [];
    const listeners = new Set<(action: ImeCandidateAction) => void>();
    let state = emptyState;
    let revision = 0;
    let owner: ImeSessionSnapshot["owner"];
    const snapshot = (): ImeSessionSnapshot => ({
      phase: owner ? "owned" : "idle",
      ...(owner ? { owner } : {}),
      engine: state,
      revision,
    });
    const bridge = {
      imeAvailable: true,
      imeSessionCommand: vi.fn(async (command: ImeSessionCommand) => {
        let commit: { text: string; revision: number } | undefined;
        if (command.type === "acquireTarget") {
          owner = { windowId: 1, webContentsId: 1, targetId: command.targetId, generation: 4 };
          trace.push("acquire");
        } else if (command.type === "processKey") {
          trace.push(`key:${command.key}`);
          if (command.key === "n")
            state = {
              ...state,
              composing: true,
              preedit: "ni",
              candidates: [{ text: "你" }, { text: "尼" }],
            };
          else if (command.key === "PageDown") {
            state = { ...state, page: state.page + 1 };
          }
        } else if (command.type === "selectCandidate") {
          trace.push(`select:${command.index}`);
          state = { ...state, composing: false, preedit: "", candidates: [] };
          revision += 1;
          commit = { text: "你", revision };
        }
        revision += 1;
        const resultSnapshot = snapshot();
        return {
          commandId: command.commandId,
          accepted: true,
          snapshot: resultSnapshot,
          ...(commit ? { commit } : {}),
        };
      }),
      getImeSessionSnapshot: async () => snapshot(),
      onImeSessionSnapshot: () => () => undefined,
      onImeCandidateAction: (listener: (action: ImeCandidateAction) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as DesktopBridge;

    let draft = "abcd";
    let commitWrites = 0;
    const textarea = document.createElement("textarea");
    textarea.dataset.imeTargetId = "composer";
    textarea.value = draft;
    document.body.append(textarea);
    textarea.focus();
    textarea.setSelectionRange(1, 3);
    const compositionSelection = { start: textarea.selectionStart, end: textarea.selectionEnd };
    const onCommit = (text: string) => {
      const edit = replaceTextRange(draft, compositionSelection, text);
      draft = edit.value;
      textarea.value = draft;
      textarea.setSelectionRange(edit.caret, edit.caret);
      commitWrites += 1;
      trace.push(`commit:${text}`);
    };
    const { result, unmount } = renderHook(() =>
      useEmbeddedIme(bridge, onCommit, true, "composer"),
    );
    await act(async () => result.current.acquire());

    act(() => {
      result.current.sendKey({
        key: "n",
        code: "KeyN",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
      } as never);
      for (const listener of listeners)
        listener({ type: "navigate", key: "PageDown", targetId: "composer", generation: 4 });
      for (const listener of listeners)
        listener({ type: "select", index: 1, targetId: "composer", generation: 4 });
      result.current.sendKey(
        {
          key: "Backspace",
          code: "Backspace",
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          repeat: false,
        } as never,
        false,
        (command) => {
          trace.push(`editor:${command.type}`);
          const edit = applyControlledTextCommand(textarea, draft, command);
          if (edit) {
            draft = edit.value;
            textarea.value = draft;
          }
        },
      );
    });

    await waitFor(() => expect(trace).toContain("editor:deleteBackward"));
    expect(trace).toEqual([
      "acquire",
      "key:n",
      "key:PageDown",
      "select:1",
      "commit:你",
      "editor:deleteBackward",
    ]);
    expect(commitWrites).toBe(1);
    expect(draft).toBe("ad");
    expect(textarea.value).toBe("ad");
    expect(bridge.imeSessionCommand).toHaveBeenCalledTimes(4);

    unmount();
    textarea.remove();
  });
});
