import { describe, expect, it } from "vitest";
import { createBuiltinToolRegistry } from "../../src/core/tool";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { createInterviewRehearsalAgent } from "../../src/interview/agent";
import {
  createInterviewIntakeAgent,
  INTERVIEW_INTAKE_AGENT_ID,
} from "../../src/interview/intake/agent";
import { INTERVIEW_INTAKE_OPENING_PROMPT } from "../../src/interview/intake/profile";
import { InterviewProfileReviewRequests } from "../../src/interview/tools/profileReviewRequests";
import { createInterviewProfileReviewTool } from "../../src/interview/tools/profileReviewTool";

/** 面试域工具由宿主注册；测试按同一组合根装配。 */
function createTools() {
  const tools = createBuiltinToolRegistry();
  tools.register(createInterviewProfileReviewTool(new InterviewProfileReviewRequests()));
  return tools;
}

describe("interview intake agent", () => {
  it("adds the opening prompt to the model request without writing a user message", async () => {
    const store = new MemoryConversationStore();
    await store.create("interview-intake");
    const tools = createTools();
    const agent = createInterviewIntakeAgent({ store, tools });

    const request = await agent.prepare(
      {
        conversationId: "interview-intake",
        runId: "run-1",
        workspaceRoot: "C:/workspace",
        interviewDataRoot: "C:/data/interview",
        profileSeed: null,
        opening: true,
        handoffTask: null,
      },
      new AbortController().signal,
    );

    expect(request.system).toContain("面试资料整理者");
    expect(request.system).toContain("是否现在开始面试演练");
    expect(request.messages).toEqual([{ role: "user", content: INTERVIEW_INTAKE_OPENING_PROMPT }]);
    expect(Object.keys(request.tools ?? {})).toEqual(
      expect.arrayContaining(["Read", "Grep", "Edit"]),
    );
    expect(await store.load("interview-intake")).toEqual(expect.objectContaining({ messages: [] }));
    expect(agent.id).toBe(INTERVIEW_INTAKE_AGENT_ID);
    await tools.dispose();
  });

  it("uses the handoff prompt instead of the first-time opening prompt", async () => {
    const store = new MemoryConversationStore();
    await store.create("interview-intake");
    const tools = createTools();
    const agent = createInterviewIntakeAgent({ store, tools });

    const request = await agent.prepare(
      {
        conversationId: "interview-intake",
        runId: "run-2",
        workspaceRoot: null,
        interviewDataRoot: "C:/data/interview",
        profileSeed: null,
        opening: true,
        handoffTask: "演练结束；本场确认了三个项目，缺少量化指标。",
      },
      new AbortController().signal,
    );

    const [message] = request.messages;
    if (message?.role !== "user") throw new Error("handoff should send a user-role prompt");
    expect(message.content).toContain("演练或面试刚结束");
    expect(message.content).toContain("缺少量化指标");
    expect(message.content).not.toBe(INTERVIEW_INTAKE_OPENING_PROMPT);
    await tools.dispose();
  });
});

describe("interview rehearsal agent", () => {
  it("references the private memory path without injecting its contents", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    const tools = createTools();
    const agent = createInterviewRehearsalAgent({ store, tools });

    const request = await agent.prepare(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        workspaceRoot: "C:/workspace",
        interviewDataRoot: "C:/data/interview",
        profileSeed: null,
        opening: false,
        handoffTask: null,
      },
      new AbortController().signal,
    );

    expect(request.system).toContain("C:/data/interview/profile.xml");
    expect(request.system).toContain("面试演练官");
    expect(request.system).toContain("<target-role>");
    expect(request.system).not.toContain("上次修改：");
    expect(Object.keys(request.tools ?? {})).toEqual(expect.arrayContaining(["Read", "Grep"]));
    expect(Object.keys(request.tools ?? {})).not.toContain("Edit");
    expect(Object.keys(request.tools ?? {})).not.toContain("RunCommand");
    await tools.dispose();
  });

  it("keeps the memory path absent when the host did not inject it", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation-1");
    const tools = createTools();
    const agent = createInterviewRehearsalAgent({ store, tools });

    const request = await agent.prepare(
      {
        conversationId: "conversation-1",
        runId: "run-1",
        workspaceRoot: null,
        interviewDataRoot: null,
        profileSeed: null,
        opening: false,
        handoffTask: null,
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
    const tools = createTools();
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
        opening: false,
        handoffTask: null,
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
