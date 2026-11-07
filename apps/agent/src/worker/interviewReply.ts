/**
 * 面试回复的组合点：把回复状态机接到会话能力与令牌反向请求。
 * 只依赖窄端口，不 import 对话领域的具体 runtime；触发源与 profile 都在 interview 域内决定。
 */

import type { ConversationSnapshot } from "@answra/shared";
import type { CommittedInterviewTurn } from "../interview/contracts";
import { InterviewReplyLoop } from "../interview/reply/loop";
import { INTERVIEW_REPLY_POLICY } from "../interview/reply/policy";
import { INTERVIEW_REPLY_PROFILE, type InterviewReplyProfile } from "../interview/reply/profile";

/** worker 组合根提供给面试回复的最小会话能力。 */
export interface InterviewReplyRuntime {
  appendUserMessage(conversationId: string, text: string): Promise<ConversationSnapshot>;
  replyToLastUserWithProfile(
    profile: InterviewReplyProfile,
    conversationId: string,
    getAccessToken: () => Promise<string>,
  ): Promise<{ runId: string }>;
  cancel(runId: string): void;
  waitForRun(runId: string): Promise<void>;
}

export interface InterviewReplyOptions {
  runtime: InterviewReplyRuntime;
  requestAccessToken: (options: { forceRefresh: boolean }) => Promise<string>;
  onTurnCommitted: (turn: CommittedInterviewTurn) => void;
  onError: (stage: "append" | "reply", error: unknown) => void;
}

export function createInterviewReplyLoop({
  runtime,
  requestAccessToken,
  onTurnCommitted,
  onError,
}: InterviewReplyOptions): InterviewReplyLoop {
  return new InterviewReplyLoop({
    source: INTERVIEW_REPLY_POLICY.source,
    ports: {
      appendUserTurn: async (conversationId, turns, text) => {
        await runtime.appendUserMessage(conversationId, text);
        for (const turn of turns) onTurnCommitted(turn);
      },
      startReply: async (conversationId) =>
        runtime.replyToLastUserWithProfile(INTERVIEW_REPLY_PROFILE, conversationId, () =>
          requestAccessToken({ forceRefresh: false }),
        ),
      cancelReply: (runId) => runtime.cancel(runId),
      waitForReply: (runId) => runtime.waitForRun(runId),
      onError,
    },
  });
}
