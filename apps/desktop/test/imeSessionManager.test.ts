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

    state = { ...state, inputMode: "ascii" };
    engine.snapshot = state;
    await manager.processKey({
      generation: 1,
      key: "Shift",
      code: "ShiftLeft",
      shift: false,
      ctrl: false,
      alt: false,
      meta: false,
      release: true,
    });
    expect(manager.snapshot).toMatchObject({
      engine: { inputMode: "ascii" },
      revision: 2,
    });
  });

  it("serializes engine commands in invocation order", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const engine = {
      snapshot: initialState,
      enable: vi.fn(async () => initialState),
      key: vi.fn(async (request: { key: string }) => {
        order.push(`${request.key}-start`);
        if (calls++ === 0)
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        order.push(`${request.key}-end`);
        return initialState;
      }),
      select: vi.fn(async () => initialState),
      reset: vi.fn(async () => initialState),
      dispose: vi.fn(),
    };
    const manager = new ImeSessionManager(engine as never);

    const key = manager.serialize(() =>
      manager.processKey({
        generation: 1,
        key: "Shift",
        code: "ShiftLeft",
        shift: true,
        ctrl: false,
        alt: false,
        meta: false,
      }),
    );
    const release = manager.serialize(() =>
      manager.processKey({
        generation: 1,
        key: "Shift",
        code: "ShiftLeft",
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
        release: true,
      }),
    );
    await Promise.resolve();
    expect(order).toEqual(["Shift-start"]);

    releaseFirst?.();
    await Promise.all([key, release]);
    expect(order).toEqual(["Shift-start", "Shift-end", "Shift-start", "Shift-end"]);
  });
});
