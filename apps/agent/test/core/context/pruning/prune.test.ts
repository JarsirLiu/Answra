import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  assertToolResultPruningPolicy,
  DEFAULT_TOOL_RESULT_PRUNING_POLICY,
  type ToolResultPruningPolicy,
} from "../../../../src/core/context/pruning/policy";
import {
  applyPrunedToolResults,
  mergePrunedToolCallIds,
  PRUNED_TOOL_RESULT_TEXT,
  pruneOldToolResults,
} from "../../../../src/core/context/pruning/prune";
import { estimateContextRequestTokens } from "../../../../src/core/context/tokenEstimate";
import {
  EDIT_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  RUN_COMMAND_TOOL_NAME,
} from "../../../../src/core/tool/toolNames";

const OPEN_POLICY: ToolResultPruningPolicy = {
  clearableToolNames: [READ_TOOL_NAME, GREP_TOOL_NAME, RUN_COMMAND_TOOL_NAME],
  protectedRecentResults: 0,
  protectedRecentMessages: 0,
};

function toolResult(
  toolName: string,
  value: string,
  toolCallId = `call-${toolName}-${value.slice(0, 4)}`,
): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output: { type: "text", value } }],
  };
}

function textOutput(message: ModelMessage | undefined): string {
  if (message?.role !== "tool") throw new Error("expected tool message");
  const part = message.content[0];
  if (part?.type !== "tool-result" || part.output.type !== "text") {
    throw new Error("expected text tool result");
  }
  return part.output.value;
}

function request(messages: ModelMessage[]) {
  return { system: "", messages };
}

describe("pruneOldToolResults", () => {
  it("clears old Read, Grep, and RunCommand results but not Edit", () => {
    const result = pruneOldToolResults({
      request: request([
        toolResult(READ_TOOL_NAME, "r".repeat(400)),
        toolResult(GREP_TOOL_NAME, "g".repeat(400)),
        toolResult(RUN_COMMAND_TOOL_NAME, "c".repeat(400)),
        toolResult(EDIT_TOOL_NAME, "e".repeat(400)),
      ]),
      targetTokens: 0,
      policy: OPEN_POLICY,
    });

    expect(result.prunedCount).toBe(3);
    expect(result.prunedToolCallIds).toEqual([
      "call-Read-rrrr",
      "call-Grep-gggg",
      "call-RunCommand-cccc",
    ]);
    expect(result.request.messages.map(textOutput)).toEqual([
      PRUNED_TOOL_RESULT_TEXT,
      PRUNED_TOOL_RESULT_TEXT,
      PRUNED_TOOL_RESULT_TEXT,
      "e".repeat(400),
    ]);
    expect(result.savedTokens).toBeGreaterThan(0);
  });

  it("keeps the last five clearable results unchanged", () => {
    const values = Array.from({ length: 8 }, (_, index) => `${index}`.repeat(200));
    const result = pruneOldToolResults({
      request: request(
        values.map((value, index) => toolResult(READ_TOOL_NAME, value, `c${index}`)),
      ),
      targetTokens: 0,
      policy: { ...OPEN_POLICY, protectedRecentResults: 5 },
    });

    expect(result.prunedCount).toBe(3);
    expect(result.request.messages.map(textOutput)).toEqual([
      PRUNED_TOOL_RESULT_TEXT,
      PRUNED_TOOL_RESULT_TEXT,
      PRUNED_TOOL_RESULT_TEXT,
      ...values.slice(3),
    ]);
  });

  it("keeps every result inside the last twelve messages unchanged", () => {
    const values = Array.from({ length: 20 }, (_, index) => `${index}`.repeat(200));
    const result = pruneOldToolResults({
      request: request(
        values.map((value, index) => toolResult(READ_TOOL_NAME, value, `c${index}`)),
      ),
      targetTokens: 0,
      policy: { ...OPEN_POLICY, protectedRecentMessages: 12 },
    });

    expect(result.prunedCount).toBe(8);
    expect(result.request.messages.map(textOutput)).toEqual([
      ...Array.from({ length: 8 }, () => PRUNED_TOOL_RESULT_TEXT),
      ...values.slice(8),
    ]);
  });

  it("stops once the target is reached", () => {
    const values = ["a".repeat(1_600), "b".repeat(1_600), "c".repeat(1_600)];
    const pruningRequest = request(
      values.map((value, index) => toolResult(READ_TOOL_NAME, value, `c${index}`)),
    );
    const before = estimateContextRequestTokens(pruningRequest);
    const result = pruneOldToolResults({
      request: pruningRequest,
      targetTokens: before - 300,
      policy: OPEN_POLICY,
    });

    expect(result.prunedCount).toBe(1);
    expect(textOutput(result.request.messages[0])).toBe(PRUNED_TOOL_RESULT_TEXT);
    expect(textOutput(result.request.messages[1])).toBe(values[1]);
    expect(textOutput(result.request.messages[2])).toBe(values[2]);
  });

  it("is idempotent after applying the placeholder", () => {
    const first = pruneOldToolResults({
      request: request([toolResult(READ_TOOL_NAME, "x".repeat(400))]),
      targetTokens: 0,
      policy: OPEN_POLICY,
    });
    const second = pruneOldToolResults({
      request: first.request,
      targetTokens: 0,
      policy: OPEN_POLICY,
    });

    expect(second.prunedCount).toBe(0);
    expect(second.savedTokens).toBe(0);
    expect(second.request).toEqual(first.request);
  });

  it("preserves tool-call pairing and toolCallId", () => {
    const call: ModelMessage = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: READ_TOOL_NAME,
          input: { file_path: "a.ts" },
        },
      ],
    };
    const result = pruneOldToolResults({
      request: request([call, toolResult(READ_TOOL_NAME, "x".repeat(400), "call-1")]),
      targetTokens: 0,
      policy: OPEN_POLICY,
    });

    expect(result.request.messages[0]).toEqual(call);
    const pruned = result.request.messages[1];
    if (pruned?.role !== "tool") throw new Error("expected tool message");
    const part = pruned.content[0];
    expect(part).toMatchObject({ type: "tool-result", toolCallId: "call-1" });
  });

  it("skips non-text tool result outputs", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "error",
            toolName: READ_TOOL_NAME,
            output: { type: "error-text", value: "x".repeat(400) },
          },
          {
            type: "tool-result",
            toolCallId: "json",
            toolName: GREP_TOOL_NAME,
            output: { type: "json", value: { value: "x".repeat(400) } },
          },
          {
            type: "tool-result",
            toolCallId: "content",
            toolName: RUN_COMMAND_TOOL_NAME,
            output: { type: "content", value: [{ type: "text", text: "x".repeat(400) }] },
          },
        ],
      },
    ];
    const result = pruneOldToolResults({
      request: request(messages),
      targetTokens: 0,
      policy: OPEN_POLICY,
    });

    expect(result.prunedCount).toBe(0);
    expect(result.request).toEqual(request(messages));
  });
});

describe("applyPrunedToolResults", () => {
  it("replaces only the requested tool results and keeps the others intact", () => {
    const messages = [
      toolResult(READ_TOOL_NAME, "a".repeat(40), "clear-1"),
      toolResult(READ_TOOL_NAME, "b".repeat(40), "keep-1"),
      toolResult(GREP_TOOL_NAME, "c".repeat(40), "clear-2"),
    ];

    const result = applyPrunedToolResults({
      request: request(messages),
      toolCallIds: ["clear-1", "missing", "clear-2"],
    });

    expect(result.appliedCount).toBe(2);
    expect(result.request.messages.map(textOutput)).toEqual([
      PRUNED_TOOL_RESULT_TEXT,
      "b".repeat(40),
      PRUNED_TOOL_RESULT_TEXT,
    ]);
  });

  it("is idempotent when the same watermark is applied again", () => {
    const first = applyPrunedToolResults({
      request: request([toolResult(READ_TOOL_NAME, "a".repeat(40), "call-1")]),
      toolCallIds: ["call-1"],
    });
    const second = applyPrunedToolResults({
      request: first.request,
      toolCallIds: ["call-1"],
    });

    expect(second.appliedCount).toBe(0);
    expect(second.request).toBe(first.request);
  });

  it("skips non-text outputs", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "error",
            toolName: READ_TOOL_NAME,
            output: { type: "error-text", value: "x".repeat(40) },
          },
        ],
      },
    ];

    expect(applyPrunedToolResults({ request: request(messages), toolCallIds: ["error"] })).toEqual({
      request: request(messages),
      appliedCount: 0,
    });
  });
});

describe("mergePrunedToolCallIds", () => {
  it("dedupes new ids and keeps their order", () => {
    expect(mergePrunedToolCallIds({ existing: ["a", "b"], added: ["b", "c", "a", "d"] })).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("drops the oldest ids above the limit", () => {
    expect(mergePrunedToolCallIds({ existing: ["a", "b"], added: ["c", "d"], limit: 3 })).toEqual([
      "b",
      "c",
      "d",
    ]);
  });
});

describe("assertToolResultPruningPolicy", () => {
  it("keeps the default policy aligned with the clearable builtin tools", () => {
    expect(DEFAULT_TOOL_RESULT_PRUNING_POLICY).toEqual({
      clearableToolNames: [READ_TOOL_NAME, GREP_TOOL_NAME, RUN_COMMAND_TOOL_NAME],
      protectedRecentResults: 5,
      protectedRecentMessages: 12,
    });
  });

  it("rejects empty names and negative protection counts", () => {
    expect(() =>
      assertToolResultPruningPolicy({ ...OPEN_POLICY, clearableToolNames: [" "] }),
    ).toThrow("可清理工具名不能为空");
    expect(() =>
      assertToolResultPruningPolicy({ ...OPEN_POLICY, protectedRecentResults: -1 }),
    ).toThrow("protectedRecentResults");
    expect(() =>
      assertToolResultPruningPolicy({ ...OPEN_POLICY, protectedRecentMessages: 1.5 }),
    ).toThrow("protectedRecentMessages");
  });
});
