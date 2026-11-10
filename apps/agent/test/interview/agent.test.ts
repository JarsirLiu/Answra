import { describe, expect, it } from "vitest";
import { createBuiltinToolRegistry } from "../../src/core/tool";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { createInterviewRehearsalAgent } from "../../src/interview/agent";

describe("interview rehearsal agent", () => {
  it("references the private memory path without injecting its contents", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    const tools = createBuiltinToolRegistry();
    const agent = createInterviewRehearsalAgent({ store, tools });

    const request = await agent.prepare(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        workspaceRoot: "C:/workspace",
        interviewDataRoot: "C:/data/interview",
      },
      new AbortController().signal,
    );

    expect(request.system).toContain("C:/data/interview/profile.md");
    expect(request.system).toContain("面试演练官");
    expect(request.system).not.toContain("上次修改：");
    expect(Object.keys(request.tools ?? {})).toEqual(
      expect.arrayContaining(["Read", "Grep", "Edit", "RunCommand", "WriteStdin"]),
    );
    await tools.dispose();
  });

  it("keeps the memory path absent when the host did not inject it", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    const tools = createBuiltinToolRegistry();
    const agent = createInterviewRehearsalAgent({ store, tools });

    const request = await agent.prepare(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        workspaceRoot: null,
        interviewDataRoot: null,
      },
      new AbortController().signal,
    );

    expect(request.system).toContain("没有可用的私有记忆目录");
    expect(request.system).not.toContain("C:/data/interview/profile.md");
    await tools.dispose();
  });
});
