import type { ConversationMessage } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { projectContextMessages } from "../../../src/core/context/projection";
import type { ContextCheckpoint } from "../../../src/core/transcript/contextCheckpoint";

function message(id: string, text: string): ConversationMessage {
  return { id, role: "user", text, images: [], status: "complete" };
}

function checkpoint(throughMessageId: string, summary: string): ContextCheckpoint {
  return {
    summary,
    throughMessageId,
    createdAt: "2026-11-13T00:00:00.000Z",
    messageCount: 1,
  };
}

describe("context projection", () => {
  it("injects the checkpoint summary as a synthetic user message before the tail", () => {
    const messages = [message("m1", "旧问题"), message("m2", "新问题")];

    const projected = projectContextMessages({
      messages,
      checkpoint: checkpoint("m1", "旧摘要正文"),
      project: (tail) => tail.map((item) => ({ role: "user", content: item.text })),
    });

    expect(projected).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "以下是之前会话的摘要。基于摘要继续，不要重复已完成的工作；需要时重新读取文件或验证，不要臆测摘要未包含的细节。\n\n旧摘要正文",
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
      project: (tail) => tail.map((item) => ({ role: "user", content: item.text })),
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
      checkpoint: checkpoint("missing", "旧摘要正文"),
      project: (tail) => tail.map((item) => ({ role: "user", content: item.text })),
    });

    expect(projected).toEqual([{ role: "user", content: "问题一" }]);
  });
});
