import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { projectConversationMessages } from "../../../src/core/transcript/projection";

const messages: ConversationMessage[] = [
  {
    id: "user-1",
    role: "user",
    audience: { kind: "user" },
    text: "帮我整理简历",
    images: [],
    status: "complete",
  },
  {
    id: "run-1",
    role: "assistant",
    authorAgentId: "candidate",
    audience: { kind: "user" },
    text: "我先看一遍。",
    images: [],
    status: "complete",
    reasoning: "内部推理",
    parts: [
      { id: "text-1", kind: "text", text: "我先看一遍。", state: "completed" },
      {
        id: "tool-1",
        kind: "tool",
        toolCallId: "tool-1",
        toolName: "Read",
        state: "completed",
        input: { file_path: "resume.md" },
        output: "resume",
      },
    ],
  },
  {
    id: "handoff-1",
    role: "assistant",
    authorAgentId: "candidate",
    audience: { kind: "bot", agentId: "intake" },
    text: "请接管整理",
    images: [],
    status: "complete",
    parts: [],
  },
];

describe("conversation projection", () => {
  it("renders a handoff as a user message for its target without leaking tools", () => {
    const projected = projectConversationMessages({
      messages,
      viewerAgentId: "intake",
      agentNames: new Map([["candidate", "候选人"]]),
    });

    expect(projected).toEqual([
      { role: "user", content: [{ type: "text", text: "帮我整理简历" }] },
      { role: "assistant", content: "我先看一遍。" },
      { role: "user", content: "【来自候选人的交接】\n请接管整理" },
    ]);
    expect(JSON.stringify(projected)).not.toContain("resume.md");
    expect(JSON.stringify(projected)).not.toContain("内部推理");
  });

  it("keeps the author's own tool replay and shows its handoff as assistant text", () => {
    const projected = projectConversationMessages({
      messages,
      viewerAgentId: "candidate",
    });

    expect(projected[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "我先看一遍。" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "Read",
          input: { file_path: "resume.md" },
        },
      ],
    });
    expect(projected[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tool-1",
          toolName: "Read",
          output: { type: "text", value: "resume" },
        },
      ],
    });
    expect(projected[3]).toEqual({ role: "assistant", content: "请接管整理" });
  });

  it("hides a handoff from unrelated Bots but keeps user-visible replies as text", () => {
    const projected = projectConversationMessages({
      messages,
      viewerAgentId: "other",
    });

    expect(projected).toEqual([
      { role: "user", content: [{ type: "text", text: "帮我整理简历" }] },
      { role: "assistant", content: "我先看一遍。" },
    ]);
  });
});
