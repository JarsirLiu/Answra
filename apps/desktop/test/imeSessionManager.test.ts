import type { ImeState } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import { ImeSessionManager } from "../src/main/ime/imeSessionManager";
import type { ImeOwnerIdentity } from "../src/main/ime/imeSessionState";

const initialState: ImeState = {
  enabled: true,
  inputMode: "chinese",
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

describe("ImeSessionManager", () => {
  it("publishes one revisioned snapshot for lease and engine state changes", async () => {
    let state = initialState;
    const engine = {
      snapshot: state,
      enable: vi.fn(async () => state),
      key: vi.fn(async () => state),
      select: vi.fn(async () => state),
      setInputMode: vi.fn(async (inputMode: "chinese" | "ascii") => {
        state = { ...state, inputMode };
        engine.snapshot = state;
        return state;
      }),
      reset: vi.fn(async () => state),
      dispose: vi.fn(),
    };
    const manager = new ImeSessionManager(engine as never);
    const owner: ImeOwnerIdentity = { windowId: 1, webContentsId: 10, targetId: "composer" };

    expect(manager.snapshot).toMatchObject({ phase: "idle", revision: 0 });
    manager.transition({ type: "acquire", owner });
    expect(manager.snapshot).toMatchObject({
      phase: "owned",
      owner: { ...owner, generation: 1 },
      revision: 1,
    });

    await manager.setInputMode("ascii");
    expect(manager.snapshot).toMatchObject({
      engine: { inputMode: "ascii" },
      revision: 2,
    });
  });

  it("serializes engine commands in invocation order", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const engine = {
      snapshot: initialState,
      enable: vi.fn(async () => initialState),
      key: vi.fn(async () => {
        order.push("key-start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("key-end");
        return initialState;
      }),
      select: vi.fn(async () => initialState),
      setInputMode: vi.fn(async () => {
        order.push("mode");
        return initialState;
      }),
      reset: vi.fn(async () => initialState),
      dispose: vi.fn(),
    };
    const manager = new ImeSessionManager(engine as never);

    const key = manager.serialize(() =>
      manager.processKey({
        generation: 1,
        key: "a",
        code: "KeyA",
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
      }),
    );
    const mode = manager.serialize(() => manager.setInputMode("ascii"));
    await Promise.resolve();
    expect(order).toEqual(["key-start"]);

    releaseFirst?.();
    await Promise.all([key, mode]);
    expect(order).toEqual(["key-start", "key-end", "mode"]);
  });
});
