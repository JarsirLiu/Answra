import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it } from "vitest";
import {
  calibrateContextTokens,
  estimateContextRequestTokens,
  estimateMessageTokens,
  estimateTextTokens,
  truncateTextToTokenBudget,
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

  it("truncates text to the same conservative token budget", () => {
    const ascii = "x".repeat(400);
    expect(truncateTextToTokenBudget(ascii, 50)).toBe("x".repeat(200));
    expect(estimateTextTokens(truncateTextToTokenBudget(ascii, 50))).toBe(50);
    expect(truncateTextToTokenBudget("中文内容", 2)).toBe("中文");
    expect(truncateTextToTokenBudget("中文内容", 0)).toBe("");
  });

  it("calibrates a raw estimate with the last successful run usage", () => {
    const anchor = {
      inputTokens: 300,
      estimatedTokens: 200,
      createdAt: "2026-11-14T10:00:00.000Z",
    };

    expect(calibrateContextTokens(100, anchor)).toBe(150);
    expect(calibrateContextTokens(100, { ...anchor, inputTokens: 100 })).toBe(100);
    expect(calibrateContextTokens(100, undefined)).toBe(100);
    expect(calibrateContextTokens(100, { ...anchor, estimatedTokens: 0 })).toBe(100);
  });
});
