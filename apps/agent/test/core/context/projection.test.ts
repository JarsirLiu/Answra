import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { projectContextMessages } from "../../../src/core/context/projection";
import type { ContextCheckpoint } from "../../../src/core/transcript/contextCheckpoint";

function message(
  id: string,
  text: string,
  role: "user" | "assistant" = "user",
): ConversationMessage {
  return { id, role, text, images: [], status: "complete" };
}

function checkpoint(
  throughMessageId: string,
  summary: string,
  retainedUserMessages?: readonly ConversationMessage[],
): ContextCheckpoint {
  return {
    summary,
    throughMessageId,
    createdAt: "2026-11-13T00:00:00.000Z",
    messageCount: 1,
    ...(retainedUserMessages ? { retainedUserMessages: [...retainedUserMessages] } : {}),
  };
}

const projectText = (messages: readonly ConversationMessage[]) =>
  messages.map((item) => ({ role: "user" as const, content: item.text }));

describe("context projection", () => {
  it("projects retained user messages before the summary and the tail", () => {
    const messages = [
      message("m1", "原始任务"),
      message("m2", "旧回答", "assistant"),
      message("m3", "新问题"),
    ];

    const projected = projectContextMessages({
      messages,
      checkpoint: checkpoint("m2", "旧摘要正文", [message("m1", "原始任务")]),
      project: projectText,
    });

    expect(projected).toEqual([
      { role: "user", content: "原始任务" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "以下是之前会话的摘要。基于摘要继续，不要重复已完成的工作；尤其不要重做已完成的写文件、提交、发消息或运行命令等有副作用的操作，需要时先做只读验证，不要臆测摘要未包含的细节。\n\n旧摘要正文",
          },
        ],
      },
      { role: "user", content: "新问题" },
    ]);
  });

  it("injects the checkpoint summary before the tail when there are no retained messages", () => {
    const messages = [message("m1", "旧问题"), message("m2", "新问题")];

    const projected = projectContextMessages({
      messages,
      checkpoint: checkpoint("m1", "旧摘要正文"),
      project: projectText,
    });

    expect(projected).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "以下是之前会话的摘要。基于摘要继续，不要重复已完成的工作；尤其不要重做已完成的写文件、提交、发消息或运行命令等有副作用的操作，需要时先做只读验证，不要臆测摘要未包含的细节。\n\n旧摘要正文",
          },
        ],
      },
      { role: "user", content: "新问题" },
    ]);
  });

  it("projects all messages when there is no checkpoint", () => {
    const messages = [message("m1", "问题一"), message("m2", "问题二")];

    const projected = projectContextMessages({
      messages,
      checkpoint: undefined,
      project: projectText,
    });

    expect(projected).toEqual([
      { role: "user", content: "问题一" },
      { role: "user", content: "问题二" },
    ]);
  });

  it("ignores a stale checkpoint instead of leaking a summary without its boundary", () => {
    const messages = [message("m1", "问题一")];

    const projected = projectContextMessages({
      messages,
      checkpoint: checkpoint("missing", "旧摘要正文", [message("m0", "旧任务")]),
      project: projectText,
    });

    expect(projected).toEqual([{ role: "user", content: "问题一" }]);
  });
});
