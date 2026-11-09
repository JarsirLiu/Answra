import { describe, expect, it } from "vitest";
import { defineTool, isToolHandlerFailure, type ToolEntry, toolId } from "../../../src/core/tool";

const entry: ToolEntry<string, string> = {
  id: toolId("test.one"),
  metadata: {
    name: "One",
    description: "test",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    sideEffectScope: "none",
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
    resultBudget: { strategy: "inline", maxModelChars: 1_024 },
  },
  inputSchema: { type: "object" },
  handler: async (input) => input,
};

describe("tool contracts", () => {
  it("creates branded tool ids and rejects empty ids", () => {
    expect(toolId("workspace.read")).toBe("workspace.read");
    expect(() => toolId("")).toThrow("工具 ID 不能为空");
    expect(() => toolId("   ")).toThrow("工具 ID 不能为空");
  });

  it("returns the entry unchanged from defineTool", () => {
    expect(defineTool(entry)).toBe(entry);
  });

  it("detects handler failures by their explicit ok marker", () => {
    expect(isToolHandlerFailure({ ok: false, code: "invalid-input", message: "bad" })).toBe(true);
    expect(isToolHandlerFailure({ ok: true })).toBe(false);
    expect(isToolHandlerFailure({ message: "missing marker" })).toBe(false);
    expect(isToolHandlerFailure(null)).toBe(false);
    expect(isToolHandlerFailure("failure")).toBe(false);
  });
});
