import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it } from "vitest";
import {
  estimateContextRequestTokens,
  estimateMessageTokens,
} from "../../../src/core/context/tokenEstimate";

function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "m1",
    role: "assistant",
    text: "",
    images: [],
    status: "complete",
    ...overrides,
  };
}

describe("context token estimate", () => {
  it("does not count message text twice when parts are present", () => {
    expect(
      estimateMessageTokens(
        message({
          text: "x".repeat(400),
          parts: [{ id: "p1", kind: "text", text: "abcd", state: "completed" }],
        }),
      ),
    ).toBe(1);
  });

  it("counts images conservatively", () => {
    expect(
      estimateMessageTokens(
        message({
          images: [{ name: "capture.png", dataUrl: "data:image/png;base64,AAAA" }],
        }),
      ),
    ).toBe(2_000);
  });

  it("estimates the final model request including system and tool results", () => {
    expect(
      estimateContextRequestTokens({
        system: "abcd",
        messages: [
          { role: "user", content: "abcd" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "read",
                output: { type: "text", value: "x".repeat(400) },
              },
            ],
          },
        ],
      }),
    ).toBe(103);
  });

  it("does not count a failed tool result's stale output as context", () => {
    const failed = estimateContextRequestTokens({
      system: "",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read",
              output: { type: "error-text", value: "failed" },
            },
          ],
        },
      ],
    });
    const completed = estimateContextRequestTokens({
      system: "",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read",
              output: { type: "text", value: "x".repeat(4_000) },
            },
          ],
        },
      ],
    });

    expect(failed).toBeLessThan(completed);
  });
});
