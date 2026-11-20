import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { renderMessagesForSummary } from "../../../src/core/context/compaction/transcript";

function message(
  id: string,
  role: ConversationMessage["role"],
  text: string,
  parts: ConversationMessagePart[] = [],
): ConversationMessage {
  return {
    id,
    role,
    text,
    images: [],
    status: "complete",
    parts,
  };
}

function textPart(id: string, text: string): ConversationMessagePart {
  return { id, kind: "text", text, state: "completed" };
}

function reasoningPart(id: string, text: string): ConversationMessagePart {
  return { id, kind: "reasoning", text, state: "completed" };
}

function toolPart(id: string, output = "工具原始输出"): ConversationMessagePart {
  return {
    id,
    kind: "tool",
    toolCallId: `call-${id}`,
    toolName: "Read",
    state: "completed",
    input: { path: "secret.txt" },
    output,
  };
}

describe("context summary transcript", () => {
  it("renders message bodies and tool details while excluding reasoning and duplicate parts", () => {
    const transcript = renderMessagesForSummary([
      message("u1", "user", "用户正文", [textPart("u1-part", "part 用户正文")]),
      message("a1", "assistant", "助手正文", [
        reasoningPart("a1-reasoning", "内部思考"),
        textPart("a1-part", "part 助手正文"),
        toolPart("a1-tool"),
      ]),
      message("a2", "assistant", "", [reasoningPart("a2-reasoning", "只有思考")]),
      message("a3", "assistant", "", [toolPart("a3-tool")]),
    ]);

    expect(transcript).toContain("### 用户\n用户正文");
    expect(transcript).toContain("### 助手\n助手正文");
    expect(transcript).toContain("[工具调用 Read]");
    expect(transcript).toContain("secret.txt");
    expect(transcript).toContain("工具原始输出");
    expect(transcript).not.toContain("part 用户正文");
    expect(transcript).not.toContain("part 助手正文");
    expect(transcript).not.toContain("内部思考");
    expect(transcript).not.toContain("只有思考");
    expect(transcript).not.toContain("### 助手\n\n");
  });

  it("keeps image names and media types without rendering image bytes", () => {
    const transcript = renderMessagesForSummary([
      {
        id: "u1",
        role: "user",
        text: "看这张图",
        images: [{ name: "screen.png", dataUrl: "data:image/png;base64,AAAA" }],
        status: "complete",
      },
    ]);

    expect(transcript).toContain("[图片：screen.png（image/png）]");
    expect(transcript).not.toContain("AAAA");
  });

  it("omits messages without a visible body", () => {
    const transcript = renderMessagesForSummary([
      {
        id: "empty",
        role: "assistant",
        text: "",
        images: [],
        status: "complete",
        reasoning: "只有思考字段",
      },
    ]);

    expect(transcript).toBe("");
  });

  it("keeps the full oversized tool result without truncation", () => {
    const output = `${"H".repeat(1_200)}MIDDLE_MARKER${"T".repeat(800)}`;
    const transcript = renderMessagesForSummary([
      message("a1", "assistant", "", [toolPart("a1-tool", output)]),
    ]);

    expect(transcript).toContain(output);
    expect(transcript).not.toContain("[已截断]");
  });

  it("keeps every tool result when many messages contain large outputs", () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      message(`a${index}`, "assistant", "", [
        toolPart(`tool-${index}`, `old-${index}-${"x".repeat(2_000)}`),
      ]),
    );

    const transcript = renderMessagesForSummary(messages);

    expect(transcript).toContain("old-0-");
    expect(transcript).toContain("old-29-");
    expect(transcript).not.toContain("[更早工具结果未进入摘要]");
  });
});
