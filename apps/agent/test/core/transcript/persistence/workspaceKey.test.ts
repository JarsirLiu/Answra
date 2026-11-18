import { describe, expect, it } from "vitest";
import { workspaceStorageKey } from "../../../../src/core/transcript/persistence/workspaceKey";

describe("workspaceStorageKey", () => {
  it("folds case on Windows and keeps the original path elsewhere", () => {
    expect(workspaceStorageKey("D:\\WorkSpace", "win32")).toBe("d:\\workspace");
    expect(workspaceStorageKey("D:\\WorkSpace", "linux")).toBe("D:\\WorkSpace");
    expect(workspaceStorageKey("/home/WorkSpace", "linux")).toBe("/home/WorkSpace");
  });
});
