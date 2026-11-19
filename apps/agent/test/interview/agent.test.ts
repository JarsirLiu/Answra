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
        profileSeed: null,
      },
      new AbortController().signal,
    );

    expect(request.system).toContain("C:/data/interview/profile.xml");
    expect(request.system).toContain("面试演练官");
    expect(request.system).toContain("<target-role>");
    expect(request.system).not.toContain("上次修改：");
    expect(Object.keys(request.tools ?? {})).toEqual(
      expect.arrayContaining(["Read", "Grep", "Edit", "RunCommand"]),
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
        profileSeed: null,
      },
      new AbortController().signal,
    );

    expect(request.system).toContain("没有可用的私有记忆目录");
    expect(request.system).not.toContain("C:/data/interview/profile.xml");
    await tools.dispose();
  });

  it("renders the onboarding seed as read-only context", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    const tools = createBuiltinToolRegistry();
    const agent = createInterviewRehearsalAgent({ store, tools });

    const request = await agent.prepare(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        workspaceRoot: null,
        interviewDataRoot: "C:/data/interview",
        profileSeed: {
          targetRole: "高级前端工程师",
          resume: {
            id: "resume-1",
            fileName: "简历.pdf",
            sourcePath: "D:/docs/简历.pdf",
          },
          projects: [{ id: "manual:1", name: "桌面助手", location: "D:/code/app" }],
          updatedAt: "2026-11-19T08:00:00.000Z",
        },
      },
      new AbortController().signal,
    );

    expect(request.system).toContain("引导资料（只读）");
    expect(request.system).toContain("高级前端工程师");
    expect(request.system).toContain("简历.pdf（D:/docs/简历.pdf）");
    expect(request.system).toContain("桌面助手；位置：D:/code/app");
    expect(request.system).toContain("用户当前指令永远优先");
    await tools.dispose();
  });
});
