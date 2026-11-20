import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { MessageRow } from "../../../src/tui/transcript/MessageRow";

const TOOL_ID = "tool-1";
const TOOL_LABEL = "Read 1 line";

function readPart() {
  return {
    id: TOOL_ID,
    kind: "tool" as const,
    toolCallId: TOOL_ID,
    toolName: "Read",
    state: "completed" as const,
    input: { file_path: "src/a.ts" },
    output: {
      type: "text",
      filePath: "src/a.ts",
      content: "x",
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    },
  };
}

function textPart(id: string, text: string) {
  return { id, kind: "text" as const, text, state: "completed" as const };
}

describe("assistant message spacing", () => {
  it("keeps one blank line on both sides of a tool call", () => {
    const instance = render(
      <MessageRow
        message={{
          id: "assistant-1",
          role: "assistant",
          text: "",
          status: "complete",
          images: [],
          parts: [textPart("text-1", "先看一下"), readPart(), textPart("text-2", "收尾说明")],
        }}
      />,
    );
    const lines = (instance.lastFrame() ?? "").split("\n");
    const before = lines.findIndex((line) => line.includes("先看一下"));
    const tool = lines.findIndex((line) => line.includes("Read"));
    const result = lines.findIndex((line) => line.includes(TOOL_LABEL));
    const after = lines.findIndex((line) => line.includes("收尾说明"));
    expect(before).toBeGreaterThanOrEqual(0);
    expect(tool).toBe(before + 2);
    expect(result).toBe(tool + 1);
    expect(after).toBe(result + 2);
    instance.unmount();
  });
});
