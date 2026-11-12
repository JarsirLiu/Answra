import { describe, expect, it } from "vitest";
import {
  summarizeToolInput,
  toolFinishLine,
  toolLabel,
  toolStartLine,
} from "../src/presentation/toolLine";

describe("tool lines", () => {
  it("maps known tool names and preserves unknown names", () => {
    expect(toolLabel("workspace.read")).toBe("Read");
    expect(toolLabel("custom.tool")).toBe("custom.tool");
  });

  it("summarizes grep input with pattern and path", () => {
    expect(summarizeToolInput("workspace.grep", { pattern: "needle", path: "src" })).toBe(
      "needle in src",
    );
    expect(
      toolStartLine({
        type: "tool-execution-started",
        toolCallId: "1",
        toolName: "workspace.grep",
        input: { pattern: "needle" },
      }),
    ).toBe("Grep(needle)");
  });

  it("joins command arrays and truncates long details", () => {
    expect(
      summarizeToolInput("workspace.run-command", {
        command: ["pnpm", "vitest", "run"],
      }),
    ).toBe("pnpm vitest run");
    const long = "x".repeat(100);
    expect(summarizeToolInput("workspace.read", long)).toHaveLength(80);
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
