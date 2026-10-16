import type { ImeSessionSnapshot } from "@answra/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  getImeComposing,
  getImeInputMode,
  getImeOwnedGeneration,
  getLatestImeSessionSnapshot,
  publishImeSessionSnapshot,
  resetImeSessionClientForTests,
  selectImeEngineState,
  selectImeOwnedGeneration,
} from "../src/ime/imeSessionClient";

function snapshot(overrides: Partial<ImeSessionSnapshot> = {}): ImeSessionSnapshot {
  return {
    phase: "idle",
    engine: {
      enabled: true,
      inputMode: "chinese",
      composing: false,
      preedit: "",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    },
    revision: 1,
    ...overrides,
  };
}

describe("imeSessionClient selectors", () => {
  afterEach(() => resetImeSessionClientForTests());

  it("projects the engine facts for key routing from a snapshot, defaulting when absent", () => {
    expect(selectImeEngineState(undefined)).toEqual({ inputMode: "chinese", composing: false });
    expect(
      selectImeEngineState(
        snapshot({
          engine: { ...snapshot().engine, inputMode: "ascii", composing: true },
        }),
      ),
    ).toEqual({ inputMode: "ascii", composing: true });
  });

  it("reports the owned generation only for the matching target", () => {
    const owned = snapshot({
      phase: "owned",
      owner: { windowId: 1, webContentsId: 1, targetId: "chat-composer", generation: 7 },
    });
    expect(selectImeOwnedGeneration(owned, "chat-composer")).toBe(7);
    expect(selectImeOwnedGeneration(owned, "reply-composer")).toBeUndefined();
    expect(selectImeOwnedGeneration(undefined, "chat-composer")).toBeUndefined();
  });

  it("derives the imperative getters from the single published snapshot", () => {
    publishImeSessionSnapshot(
      snapshot({ engine: { ...snapshot().engine, inputMode: "ascii", composing: true } }),
    );
    expect(getImeInputMode()).toBe("ascii");
    expect(getImeComposing()).toBe(true);
    expect(getImeOwnedGeneration("chat-composer")).toBeUndefined();
  });

  it("ignores a snapshot that regresses the authoritative revision", () => {
    publishImeSessionSnapshot(
      snapshot({ revision: 5, engine: { ...snapshot().engine, inputMode: "ascii" } }),
    );
    publishImeSessionSnapshot(
      snapshot({ revision: 4, engine: { ...snapshot().engine, inputMode: "chinese" } }),
    );

    expect(getImeInputMode()).toBe("ascii");
    expect(getLatestImeSessionSnapshot()?.revision).toBe(5);
  });
});
