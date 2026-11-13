import { describe, expect, it } from "vitest";
import { toolFinishLine, toolLabel, toolStartLine } from "../../src/presentation/toolLine";

describe("tool lines", () => {
  it("maps known tool names and preserves unknown names", () => {
    expect(toolLabel("workspace.read")).toBe("Read");
    expect(toolLabel("Read")).toBe("Read");
    expect(toolLabel("workspace.grep")).toBe("Search");
    expect(toolLabel("custom.tool")).toBe("custom.tool");
  });

  it("summarizes grep input with pattern and path", () => {
    expect(
      toolStartLine({
        type: "tool-execution-started",
        toolCallId: "1",
        toolName: "workspace.grep",
        input: { pattern: "needle", path: "src" },
      }),
    ).toBe('Search(pattern: "needle", path: "src")');
    expect(
      toolStartLine({
        type: "tool-execution-started",
        toolCallId: "1",
        toolName: "Grep",
        input: { pattern: "needle" },
      }),
    ).toBe('Search(pattern: "needle")');
  });

  it("summarizes read and run-command inputs", () => {
    expect(
      toolStartLine({
        type: "tool-execution-started",
        toolCallId: "1",
        toolName: "workspace.read",
        input: { file_path: "src/a.ts" },
      }),
    ).toBe("Read(src/a.ts)");
    expect(
      toolStartLine({
        type: "tool-execution-started",
        toolCallId: "1",
        toolName: "workspace.run-command",
        input: { command: ["pnpm", "vitest", "run"] },
      }),
    ).toBe("Bash(pnpm vitest run)");
  });

  it("renders successful and failed finish lines", () => {
    expect(
      toolFinishLine({
        type: "tool-execution-finished",
        toolCallId: "1",
        toolName: "workspace.read",
        input: {},
        result: { success: true, output: "ok" },
        durationMs: 9,
      }),
    ).toBe("Read ok 9ms");
    expect(
      toolFinishLine({
        type: "tool-execution-finished",
        toolCallId: "1",
        toolName: "workspace.read",
        input: {},
        result: { success: false, errorText: "nope" },
        durationMs: 2,
      }),
    ).toBe("Read failed 2ms: nope");
  });
});
