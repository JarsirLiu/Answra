import { describe, expect, it } from "vitest";
import { toolLabel } from "../../src/presentation/toolLabels";
import { toolFinishLine, toolStartLine } from "../../src/presentation/toolLine";

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
        toolName: "workspace.grep",
        input: { pattern: "needle", path: "src" },
      }),
    ).toBe('Search(pattern: "needle", path: "src")');
    expect(
      toolStartLine({
        toolName: "Grep",
        input: { pattern: "needle" },
      }),
    ).toBe('Search(pattern: "needle")');
  });

  it("summarizes read and run-command inputs", () => {
    expect(
      toolStartLine({
        toolName: "workspace.read",
        input: { file_path: "src/a.ts" },
      }),
    ).toBe("Read(src/a.ts)");
    expect(
      toolStartLine({
        toolName: "workspace.run-command",
        input: { command: ["pnpm", "vitest", "run"] },
      }),
    ).toBe("Bash(pnpm vitest run)");
  });

  it("renders successful, failed and denied finish lines", () => {
    expect(
      toolFinishLine({
        toolName: "workspace.read",
        outcome: "output",
        durationMs: 9,
      }),
    ).toBe("Read ok 9ms");
    expect(
      toolFinishLine({
        toolName: "workspace.read",
        outcome: "error",
        errorText: "nope",
        durationMs: 2,
      }),
    ).toBe("Read failed 2ms: nope");
    expect(toolFinishLine({ toolName: "workspace.read", outcome: "denied" })).toBe("Read failed");
  });
});
