import { Bot, FolderKanban, MessageCircle, Sparkles } from "lucide-react";

/**
 * 面试引导的广告式主视觉：薄荷渐变海报 + 悬浮简历卡 + 机器人头像，
 * 全部由 DOM/CSS 组成，不引入位图资产；颜色只引用语义令牌。
 */
export function InterviewOnboardingArt() {
  return (
    <div aria-hidden="true" className="interview-onboarding-art">
      <span className="interview-onboarding-art__wash is-one" />
      <span className="interview-onboarding-art__wash is-two" />
      <span className="interview-onboarding-art__ring" />
      <span className="interview-onboarding-art__avatar">
        <Bot size={28} strokeWidth={1.6} />
        <span className="interview-onboarding-art__avatar-badge">
          <Sparkles size={11} strokeWidth={2} />
        </span>
      </span>
      <span className="interview-onboarding-art__sheet">
        <span className="interview-onboarding-art__tape" />
        <span className="interview-onboarding-art__sheet-badge">
          <Sparkles size={12} strokeWidth={1.8} />
        </span>
        <span className="interview-onboarding-art__line" />
        <span className="interview-onboarding-art__line is-short" />
        <span className="interview-onboarding-art__line" />
        <span className="interview-onboarding-art__line is-shortest" />
      </span>
      <span className="interview-onboarding-art__pill is-project">
        <FolderKanban size={13} strokeWidth={1.9} />
      </span>
      <span className="interview-onboarding-art__pill is-story">
        <MessageCircle size={13} strokeWidth={1.9} />
      </span>
      <span className="interview-onboarding-art__spark is-one" />
      <span className="interview-onboarding-art__spark is-two" />
      <span className="interview-onboarding-art__spark is-three" />
    </div>
  );
}
