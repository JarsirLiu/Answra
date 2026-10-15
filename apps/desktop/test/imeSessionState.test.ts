import { describe, expect, it } from "vitest";
import {
  type ImeOwnerIdentity,
  initialImeSessionState,
  reduceImeSession,
} from "../src/main/ime/imeSessionState";

const composer: ImeOwnerIdentity = { windowId: 1, webContentsId: 11, targetId: "composer" };
const search: ImeOwnerIdentity = { windowId: 1, webContentsId: 11, targetId: "workspace-search" };
const reply: ImeOwnerIdentity = { windowId: 2, webContentsId: 22, targetId: "composer" };

describe("reduceImeSession", () => {
  it("requires the active generation and identity to release a lease", () => {
    const owned = reduceImeSession(initialImeSessionState, { type: "acquire", owner: composer });
    const generation = owned.generation;

    expect(
      reduceImeSession(owned, { type: "release", owner: composer, generation: generation - 1 }),
    ).toEqual(owned);
    expect(reduceImeSession(owned, { type: "release", owner: reply, generation })).toEqual(owned);
    expect(reduceImeSession(owned, { type: "release", owner: composer, generation })).toEqual({
      status: "idle",
      generation,
    });
  });

  it("invalidates prior target generations when focus moves within a window", () => {
    const first = reduceImeSession(initialImeSessionState, { type: "acquire", owner: composer });
    const next = reduceImeSession(first, { type: "acquire", owner: search });

    expect(next.status).toBe("owned");
    expect(next.generation).toBe(first.generation + 1);
    expect(next).toMatchObject({ owner: search });
    expect(
      reduceImeSession(next, {
        type: "release",
        owner: composer,
        generation: first.generation,
      }),
    ).toEqual(next);
  });

  it("suspends on native blur and only resumes after matching editor confirmation", () => {
    const owned = reduceImeSession(initialImeSessionState, { type: "acquire", owner: composer });
    const suspended = reduceImeSession(owned, {
      type: "suspend",
      owner: composer,
      generation: owned.generation,
    });

    expect(suspended.status).toBe("suspended");
    expect(
      reduceImeSession(suspended, {
        type: "confirm-focus",
        owner: composer,
        generation: owned.generation - 1,
      }),
    ).toEqual(suspended);
    expect(
      reduceImeSession(suspended, {
        type: "confirm-focus",
        owner: composer,
        generation: owned.generation,
      }).status,
    ).toBe("owned");
  });

  it("invalidates a destroyed renderer and refuses work after disposal", () => {
    const owned = reduceImeSession(initialImeSessionState, { type: "acquire", owner: reply });
    const destroyed = reduceImeSession(owned, {
      type: "owner-destroyed",
      windowId: reply.windowId,
      webContentsId: reply.webContentsId,
    });
    expect(destroyed).toEqual({ status: "idle", generation: owned.generation + 1 });

    const disposed = reduceImeSession(destroyed, { type: "dispose" });
    expect(reduceImeSession(disposed, { type: "acquire", owner: composer })).toEqual(disposed);
  });
});
