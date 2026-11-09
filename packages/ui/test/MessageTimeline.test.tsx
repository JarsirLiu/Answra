import type { ConversationMessagePart } from "@answra/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { groupMessageParts, MessageTimeline } from "../src/components/chat/MessageTimeline";

const PARTS: ConversationMessagePart[] = [
  { id: "r1", kind: "reasoning", text: "先思考", state: "completed" },
  { id: "r2", kind: "reasoning", text: "再判断", state: "completed" },
  { id: "t1", kind: "text", text: "第一段", state: "completed" },
  { id: "t2", kind: "text", text: "第二段", state: "completed" },
  {
    id: "tool1",
    kind: "tool",
    toolCallId: "tool1",
    toolName: "Mystery",
    state: "completed",
    input: {},
    output: "done",
  },
  { id: "t3", kind: "text", text: "第三段", state: "streaming" },
];

describe("MessageTimeline", () => {
  it("groups adjacent text and reasoning while preserving tool boundaries", () => {
    const segments = groupMessageParts(PARTS);

    expect(segments.map((segment) => segment.kind)).toEqual(["reasoning", "text", "tool", "text"]);
    expect(segments[0]).toMatchObject({ text: "先思考\n\n再判断" });
    expect(segments[1]).toMatchObject({ text: "第一段第二段" });
    expect(segments[3]).toMatchObject({ text: "第三段", streaming: true });
  });

  it("renders text, tool, and text in their real event order", () => {
    render(<MessageTimeline caret parts={PARTS} thinking={false} />);

    const firstText = screen.getByText(/第一段/);
    const tool = screen.getByText("Mystery");
    const lastText = screen.getByText("第三段");

    expect(firstText.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tool.compareDocumentPosition(lastText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the thinking state before a reasoning part exists", () => {
    render(<MessageTimeline parts={[]} thinking />);

    expect(screen.getByText("思考中…")).toBeInTheDocument();
  });
});
