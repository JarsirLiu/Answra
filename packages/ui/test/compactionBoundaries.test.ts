import type { ContextCompactionBoundary } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { mergeCompactionBoundaries } from "../src/components/chat/compactionBoundaries";
import type { ConversationViewMessage } from "../src/components/chat/conversationMessage";

const message = (id: string): ConversationViewMessage => ({
  id,
  role: "user",
  text: id,
  status: "complete",
  images: [],
});

const boundary = (id: string, throughMessageId: string): ContextCompactionBoundary => ({
  id,
  throughMessageId,
  createdAt: "2026-11-14T10:00:00.000Z",
  summary: `summary-${id}`,
  summarizedMessages: 2,
});

describe("mergeCompactionBoundaries", () => {
  it("inserts boundaries after their through message and keeps unknown anchors at the end", () => {
    const items = mergeCompactionBoundaries(
      [message("a"), message("b")],
      [boundary("one", "b"), boundary("two", "missing")],
    );

    expect(items.map((item) => item.id)).toEqual(["a", "b", "one", "two"]);
  });

  it("keeps multiple boundaries after the same message in order", () => {
    const items = mergeCompactionBoundaries(
      [message("a")],
      [boundary("one", "a"), boundary("two", "a")],
    );

    expect(items.map((item) => item.id)).toEqual(["a", "one", "two"]);
  });
});
