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

  it("projects the in-flight assistant message so the next step sees its tool round-trip", () => {
    const inFlight: ConversationMessage = {
      id: "assistant-2",
      role: "assistant",
      authorAgentId: "coding.engineer",
      audience: { kind: "user" },
      text: "",
      images: [],
      status: "streaming",
      parts: [
        {
          id: "tool-2",
          kind: "tool",
          toolCallId: "tool-2",
          toolName: "Skill",
          state: "completed",
          input: { name: "answra-code" },
          output: "<skill_content/>",
        },
      ],
    };

    const projected = projectConversationMessages({
      messages: [...messages.slice(0, 1), inFlight],
      activeMessageId: "assistant-2",
    });

    expect(projected).toEqual([
      { role: "user", content: [{ type: "text", text: "帮我整理简历" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-2",
            toolName: "Skill",
            input: { name: "answra-code" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-2",
            toolName: "Skill",
            output: { type: "text", value: "<skill_content/>" },
          },
        ],
      },
    ]);
  });

  it("still skips a streaming message that is not the active one", () => {
    const active: ConversationMessage = {
      id: "assistant-2",
      role: "assistant",
      audience: { kind: "user" },
      text: "",
      images: [],
      status: "streaming",
      parts: [],
    };
    const stale: ConversationMessage = { ...active, id: "assistant-stale", text: "残留" };

    const projected = projectConversationMessages({
      messages: [...messages.slice(0, 1), stale, active],
      activeMessageId: "assistant-2",
    });

    expect(projected).toEqual([
      { role: "user", content: [{ type: "text", text: "帮我整理简历" }] },
    ]);
  });

  it("does not project an empty active message before the first step", () => {
    const active: ConversationMessage = {
      id: "assistant-2",
      role: "assistant",
      audience: { kind: "user" },
      text: "",
      images: [],
      status: "streaming",
      parts: [],
    };

    const projected = projectConversationMessages({
      messages: [...messages.slice(0, 1), active],
      activeMessageId: "assistant-2",
    });

    expect(projected).toEqual([
      { role: "user", content: [{ type: "text", text: "帮我整理简历" }] },
    ]);
  });
});
