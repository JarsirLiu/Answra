import { describe, expect, it, vi } from "vitest";
import {
  type CommittedInterviewTurn,
  conversationId,
  sessionId,
  turnId,
} from "../../src/interview/contracts";
import { INTERVIEW_REPLY_PROFILE } from "../../src/interview/reply/profile";
import { createInterviewReplyLoop } from "../../src/worker/interviewReply";

function turn(): CommittedInterviewTurn {
  return {
    sessionId: sessionId("session-1"),
    conversationId: conversationId("conversation-1"),
    turnId: turnId("session-1:u1"),
    version: 0,
    status: "committed",
    chunks: [],
    missingChunkIndexes: [],
  };
}

describe("interview reply composition", () => {
  it("uses the interview-owned profile and keeps the conversation runtime behind a narrow port", async () => {
    const appendUserMessage = vi.fn(async () => undefined);
    const replyToLastUserWithProfile = vi.fn(
      async (
        _profile: typeof INTERVIEW_REPLY_PROFILE,
        _conversationId: string,
        _getAccessToken: () => Promise<string>,
      ) => ({ runId: "run-1" }),
    );
    const runtime = {
      appendUserMessage,
      replyToLastUserWithProfile,
      cancel: vi.fn(),
      waitForRun: vi.fn(async () => undefined),
    };
    const requestAccessToken = vi.fn(async () => "access-token");
    const onTurnCommitted = vi.fn();
    const loop = createInterviewReplyLoop({
      runtime,
      requestAccessToken,
      onTurnCommitted,
      onError: vi.fn(),
    });

    await loop.turnSettled("conversation-1", [turn()], "请自我介绍");

    expect(appendUserMessage).toHaveBeenCalledWith("conversation-1", "请自我介绍");
    expect(onTurnCommitted).toHaveBeenCalledWith(expect.objectContaining({ version: 0 }));
    expect(replyToLastUserWithProfile).toHaveBeenCalledTimes(1);
    const [profile, resolvedConversationId, getAccessToken] =
      replyToLastUserWithProfile.mock.calls[0] ?? [];
    expect(profile).toBe(INTERVIEW_REPLY_PROFILE);
    if (!profile) throw new Error("missing interview reply profile");
    expect(profile.tools).toEqual([]);
    expect(profile.includeHistory).toBe(true);
    expect(resolvedConversationId).toBe("conversation-1");
    expect(typeof getAccessToken).toBe("function");
    if (!getAccessToken) throw new Error("missing access token getter");
    await expect(getAccessToken()).resolves.toBe("access-token");
    expect(requestAccessToken).toHaveBeenCalledWith({ forceRefresh: false });
  });
});
