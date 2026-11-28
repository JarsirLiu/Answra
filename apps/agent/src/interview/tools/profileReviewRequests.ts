/** 演练/辅助 Bot 提交的“交给资料整理者”请求；只存内存，Turn 结束后由宿主取走。 */

export const INTERVIEW_PROFILE_REVIEW_REASONS = [
  "interview-ended",
  "user-requested",
  "blocked-by-gap",
] as const;

export type InterviewProfileReviewReason = (typeof INTERVIEW_PROFILE_REVIEW_REASONS)[number];

export interface InterviewProfileReviewRequest {
  reason: InterviewProfileReviewReason;
  /** 给资料整理者的交接说明；不是用户消息，不写 transcript。 */
  summary: string;
}

export class InterviewProfileReviewRequests {
  private readonly bySession = new Map<string, InterviewProfileReviewRequest>();

  record(sessionId: string, request: InterviewProfileReviewRequest): void {
    this.bySession.set(sessionId, request);
  }

  take(sessionId: string): InterviewProfileReviewRequest | undefined {
    const request = this.bySession.get(sessionId);
    if (request) this.bySession.delete(sessionId);
    return request;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
