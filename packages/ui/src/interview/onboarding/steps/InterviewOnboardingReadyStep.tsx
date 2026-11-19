/** 引导第三步：确认画像摘要与目标岗位；目标岗位状态由外壳持有。 */
import {
  INTERVIEW_TARGET_ROLE_MAX_LENGTH,
  type InterviewOnboardingProject,
  type InterviewOnboardingState,
} from "@answra/shared";
import { InterviewReadyPoster } from "../InterviewReadyPoster";

interface InterviewOnboardingReadyStepProps {
  state: InterviewOnboardingState;
  selectedProjects: InterviewOnboardingProject[];
  targetRole: string;
  onTargetRoleChange: (value: string) => void;
}

export function InterviewOnboardingReadyStep({
  state,
  selectedProjects,
  targetRole,
  onTargetRoleChange,
}: InterviewOnboardingReadyStepProps) {
  return (
    <section
      aria-labelledby="interview-onboarding-ready-title"
      className="interview-onboarding-body interview-onboarding-ready"
    >
      <h1 id="interview-onboarding-ready-title">开始制作面试分身</h1>
      <p className="interview-onboarding-lead">最后确认一下，马上开始制作。</p>

      <InterviewReadyPoster fileName={state.resume?.fileName ?? null} projects={selectedProjects} />

      <label className="interview-onboarding-field" htmlFor="interview-onboarding-target-role">
        目标岗位（可选）
        <input
          id="interview-onboarding-target-role"
          maxLength={INTERVIEW_TARGET_ROLE_MAX_LENGTH}
          onChange={(event) => onTargetRoleChange(event.target.value)}
          placeholder="例如：高级前端工程师"
          value={targetRole}
        />
      </label>
    </section>
  );
}
