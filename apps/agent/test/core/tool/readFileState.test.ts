import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReadFileStateMap } from "../../../src/core/tool";
import {
  clearReadFileStatesForPath,
  createReadFileStateKey,
  findReadFileStateForEdit,
  isCachedReadFresh,
  matchesFileStat,
  recordEditedFileState,
} from "../../../src/core/tool/builtin/readFileState";

const filePath = path.resolve(os.tmpdir(), "answra-read-state.md");

function stateWith(
  entries: Array<{
    filePath?: string;
    offset?: number;
    limit?: number;
    partialView?: boolean;
    origin?: "read" | "edit";
    mtimeMs?: number;
    sizeBytes?: number;
  }>,
): ReadFileStateMap {
  const state: ReadFileStateMap = new Map();
  for (const entry of entries) {
    const target = entry.filePath ?? filePath;
    const offset = entry.offset ?? 1;
    state.set(createReadFileStateKey(target, offset, entry.limit), {
      path: target,
      mtimeMs: entry.mtimeMs ?? 10,
      sizeBytes: entry.sizeBytes ?? 5,
      offset,
      limit: entry.limit,
      partialView: entry.partialView ?? false,
      origin: entry.origin ?? "read",
    });
  }
  return state;
}

describe("read file state", () => {
  it("keys cached reads by path and line range", () => {
    expect(createReadFileStateKey(filePath, 1, undefined)).not.toBe(
      createReadFileStateKey(filePath, 1, 2),
    );
    expect(createReadFileStateKey(filePath, 1, undefined)).toBe(
      createReadFileStateKey(filePath, 1, undefined),
    );
  });

  it("treats only fresh complete Read entries as file_unchanged", () => {
    const stat = { mtimeMs: 10.9, sizeBytes: 5 };

    expect(
      isCachedReadFresh(
        {
          path: filePath,
          mtimeMs: 10,
          sizeBytes: 5,
          offset: 1,
          limit: undefined,
          partialView: false,
          origin: "read",
        },
        stat,
      ),
    ).toBe(true);
    expect(
      isCachedReadFresh(
        {
          path: filePath,
          mtimeMs: 10,
          sizeBytes: 5,
          offset: 1,
          limit: undefined,
          partialView: false,
          origin: "edit",
        },
        stat,
      ),
    ).toBe(false);
  });

  it("does not use a partial view as an edit baseline", () => {
    const state = stateWith([
      { partialView: true, mtimeMs: 10, sizeBytes: 5 },
      { offset: 2, partialView: false, mtimeMs: 11, sizeBytes: 6 },
    ]);

    expect(findReadFileStateForEdit(state, filePath)).toMatchObject({
      offset: 2,
      mtimeMs: 11,
      sizeBytes: 6,
    });
    expect(findReadFileStateForEdit(stateWith([{ partialView: true }]), filePath)).toBeUndefined();
  });

  it("compares mtime and size for both read and edit baselines", () => {
    const editEntry = {
      path: filePath,
      mtimeMs: 10,
      sizeBytes: 5,
      offset: 1,
      limit: undefined,
      partialView: false,
      origin: "edit" as const,
    };

    expect(matchesFileStat(editEntry, { mtimeMs: 10.2, sizeBytes: 5 })).toBe(true);
    expect(matchesFileStat(editEntry, { mtimeMs: 11, sizeBytes: 5 })).toBe(false);
    expect(matchesFileStat(editEntry, { mtimeMs: 10, sizeBytes: 6 })).toBe(false);
  });

  it("clears every cached range for one path and keeps other files", () => {
    const other = path.resolve(os.tmpdir(), "other.md");
    const state = stateWith([{ limit: 1 }, { offset: 2 }, { filePath: other }]);

    clearReadFileStatesForPath(state, filePath);

    expect([...state.values()].map((entry) => entry.path)).toEqual([other]);
  });

  it("records an edit baseline that allows another edit but not a cache hit", () => {
    const state: ReadFileStateMap = new Map();

    recordEditedFileState(state, { path: filePath, mtimeMs: 12.8, sizeBytes: 7 });

    const entry = state.get(createReadFileStateKey(filePath, 1, undefined));
    if (!entry) throw new Error("expected an edit baseline");
    expect(entry).toMatchObject({
      mtimeMs: 12,
      sizeBytes: 7,
      offset: 1,
      limit: undefined,
      partialView: false,
      origin: "edit",
    });
    expect(findReadFileStateForEdit(state, filePath)).toBe(entry);
    expect(isCachedReadFresh(entry, { mtimeMs: 12, sizeBytes: 7 })).toBe(false);
  });
});
