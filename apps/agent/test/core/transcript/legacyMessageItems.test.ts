import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { legacyMessagesToItems } from "../../../src/core/transcript/persistence/sqlite/legacyMessageItems";

const AT = "2026-11-23T10:00:00.000Z";

describe("legacyMessagesToItems", () => {
  it("scopes repeated provider part ids so every text block is kept", () => {
    const { items } = legacyMessagesToItems(
      [
        userMessage("m-u1", "第一轮"),
        assistantMessage("m-a1", [textPart("txt-0", "第一段")]),
        userMessage("m-u2", "第二轮"),
        assistantMessage("m-a2", [
          textPart("txt-0", "第二段"),
          toolPart("c-1"),
          textPart("txt-0", "第三段"),
        ]),
      ],
      AT,
    );

    expect(new Set(items.map((item) => item.itemId)).size).toBe(items.length);
    expect(
      items.flatMap((item) => (item.payload.kind === "text" ? [item.payload.text] : [])),
    ).toEqual(["第一段", "第二段", "第三段"]);
  });
});

function userMessage(id: string, text: string): ConversationMessage {
  return {
    id,
    role: "user",
    audience: { kind: "user" },
    text,
    images: [],
    status: "complete",
    parts: [],
  };
}

function assistantMessage(id: string, parts: ConversationMessagePart[]): ConversationMessage {
  return {
    id,
    role: "assistant",
    authorAgentId: "general",
    audience: { kind: "user" },
    text: parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join(""),
    images: [],
    status: "complete",
    parts,
  };
}

function textPart(id: string, text: string): ConversationMessagePart {
  return { id, kind: "text", text, state: "completed" };
}

function toolPart(id: string): ConversationMessagePart {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    toolName: "read",
    input: { path: "a" },
    state: "completed",
    output: "ok",
  };
}
