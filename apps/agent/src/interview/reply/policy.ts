/**
 * 面试回复的触发策略：哪一路语音会触发回答、哪一路开口会取消在途回答。
 * 放在面试领域内，worker 只消费；切换触发源时先改这里，并同步放行采集与 turn 装配。
 */
import type { AudioSource } from "../contracts";

export const INTERVIEW_REPLY_POLICY = {
  source: "candidate",
} as const satisfies {
  /** 只有这一路语音的开口会取消在途回复，也只有它的结算会触发回答。 */
  source: AudioSource;
};
