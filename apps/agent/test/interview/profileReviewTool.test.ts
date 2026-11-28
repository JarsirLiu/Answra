import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/core/tool";
import { InterviewProfileReviewRequests } from "../../src/interview/tools/profileReviewRequests";
import {
  createInterviewProfileReviewTool,
  INTERVIEW_PROFILE_REVIEW_SUMMARY_MAX_CHARS,
  INTERVIEW_PROFILE_REVIEW_TOOL_ID,
  INTERVIEW_PROFILE_REVIEW_TOOL_NAME,
} from "../../src/interview/tools/profileReviewTool";

function context(sessionId = "active-interview-conversation"): ToolContext {
  return {
    toolCallId: "tool-1",
    signal: new AbortController().signal,
    workspaceRoot: null,
    runId: "run-1",
    sessionId,
  };
}

describe("interview.request-profile-review", () => {
  it("records the request without changing any stage state", async () => {
    const requests = new InterviewProfileReviewRequests();
    const tool = createInterviewProfileReviewTool(requests);

    const output = await tool.handler(
      { reason: "interview-ended", summary: "  本场确认了三个项目，缺少指标  " },
      context(),
    );

    expect(tool.id).toBe(INTERVIEW_PROFILE_REVIEW_TOOL_ID);
    expect(tool.metadata.name).toBe(INTERVIEW_PROFILE_REVIEW_TOOL_NAME);
    expect(output).toEqual(expect.objectContaining({ accepted: true, reason: "interview-ended" }));
    expect(requests.take("active-interview-conversation")).toEqual({
      reason: "interview-ended",
      summary: "本场确认了三个项目，缺少指标",
    });
    // 取走即清空：同一次交接不会被重复兑现。
    expect(requests.take("active-interview-conversation")).toBeUndefined();
  });

  it("rejects an empty summary instead of recording a blank handoff", async () => {
    const requests = new InterviewProfileReviewRequests();
    const tool = createInterviewProfileReviewTool(requests);

    const output = await tool.handler(
      { reason: "user-requested", summary: "   " },
      context("assist-session"),
    );

    expect(output).toEqual(expect.objectContaining({ ok: false, code: "invalid-input" }));
    expect(requests.take("assist-session")).toBeUndefined();
  });

  it("keeps requests isolated per conversation", () => {
    const requests = new InterviewProfileReviewRequests();
    requests.record("rehearsal", { reason: "interview-ended", summary: "演练结束" });
    requests.record("assist", { reason: "user-requested", summary: "用户要求补画像" });

    expect(requests.take("rehearsal")?.summary).toBe("演练结束");
    expect(requests.take("assist")?.summary).toBe("用户要求补画像");
  });

  it("describes the prohibited cases so the model does not summon mid-interview", () => {
    const tool = createInterviewProfileReviewTool(new InterviewProfileReviewRequests());

    expect(tool.metadata.description).toContain("禁止在一场进行中的演练/面试里调用");
    expect(tool.metadata.description).toContain("普通追问");
    expect(tool.metadata.resultBudget.maxModelChars).toBeGreaterThanOrEqual(
      INTERVIEW_PROFILE_REVIEW_SUMMARY_MAX_CHARS / 2,
    );
  });
});
