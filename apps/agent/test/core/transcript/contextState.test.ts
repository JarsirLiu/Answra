import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { compactionBoundaries } from "../../../src/core/transcript/contextBoundary";
import {
  type ContextCheckpoint,
  latestCheckpoint,
  messagesAfterCheckpoint,
} from "../../../src/core/transcript/contextCheckpoint";

function message(id: string): ConversationMessage {
  return { id, role: "user", text: id, images: [], status: "complete" };
}

function checkpoint(throughMessageId: string, summary = "旧摘要"): ContextCheckpoint {
  return {
    summary,
    throughMessageId,
    createdAt: "2026-11-14T10:00:00.000Z",
    messageCount: 2,
  };
}

describe("context checkpoints", () => {
  it("returns the latest checkpoint", () => {
    const latest = checkpoint("m2");

    expect(latestCheckpoint({ checkpoints: [checkpoint("m1"), latest] })).toBe(latest);
    expect(latestCheckpoint(undefined)).toBeUndefined();
  });

  it("returns the messages after the checkpoint boundary", () => {
    const messages = [message("m1"), message("m2"), message("m3")];

    expect(messagesAfterCheckpoint(messages, checkpoint("m2"))).toEqual([message("m3")]);
  });

  it("returns undefined when the checkpoint boundary is missing", () => {
    const messages = [message("m1")];

    expect(messagesAfterCheckpoint(messages, checkpoint("missing"))).toBeUndefined();
  });
});

describe("context boundaries", () => {
  it("projects only the boundary identity without the summary body", () => {
    expect(compactionBoundaries({ checkpoints: [checkpoint("m2", "不可下发")] })).toEqual([
      {
        id: "compaction:2026-11-14T10:00:00.000Z:m2",
        throughMessageId: "m2",
        createdAt: "2026-11-14T10:00:00.000Z",
      },
    ]);
  });
});
