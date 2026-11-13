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

function toolPart(id: string): ConversationMessagePart {
  return {
    id,
    kind: "tool",
    toolCallId: `call-${id}`,
    toolName: "Read",
    state: "completed",
    input: { path: "secret.txt" },
    output: "工具原始输出",
  };
}

describe("context summary transcript", () => {
  it("renders only the message body and excludes reasoning and tool details", () => {
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
    expect(transcript).not.toContain("part 用户正文");
    expect(transcript).not.toContain("part 助手正文");
    expect(transcript).not.toContain("内部思考");
    expect(transcript).not.toContain("只有思考");
    expect(transcript).not.toContain("工具原始输出");
    expect(transcript).not.toContain("secret.txt");
    expect(transcript).not.toContain("### 助手\n\n");
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
});
