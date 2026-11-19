import type { DesktopBridge } from "@answra/shared";
import { SurfaceButton } from "../components/controls/SurfaceButton";
import { PanelShell } from "../components/panels/PanelShell";
import { InterviewIntakePanel } from "../interview/intake/InterviewIntakePanel";
import { InterviewOnboardingPanel } from "../interview/onboarding/InterviewOnboardingPanel";
import { useInterviewOnboarding } from "../interview/onboarding/useInterviewOnboarding";
import "../interview/onboarding/onboarding.css";

interface InterviewFeaturePanelProps {
  platform: DesktopBridge | undefined;
  onClose: () => void;
}

/** 面试入口：未完成时显示引导；完成/跳过后直接进入 intake 对话。 */
export function InterviewFeaturePanel({ platform, onClose }: InterviewFeaturePanelProps) {
  const onboarding = useInterviewOnboarding(platform);

  if (onboarding.loading) {
    return <InterviewNotice message="正在读取面试引导…" onClose={onClose} />;
  }

  if (onboarding.error && !onboarding.state) {
    return (
      <InterviewNotice message={onboarding.error} onClose={onClose} onRetry={onboarding.reload} />
    );
  }

  if (onboarding.state?.status === "pending") {
    return (
      <InterviewOnboardingPanel
        error={onboarding.error}
        onAddProject={onboarding.addProject}
        onClose={onClose}
        onComplete={onboarding.complete}
        onImportResume={onboarding.importResume}
        onPickResume={onboarding.pickResume}
        onSkip={onboarding.skip}
        onUpdate={onboarding.update}
        state={onboarding.state}
      />
    );
  }

  if (onboarding.state) {
    return (
      <InterviewIntakePanel
        onClose={onClose}
        onReopenOnboarding={onboarding.reopen}
        platform={platform}
      />
    );
  }

  return <InterviewNotice message="当前版本不支持面试引导" onClose={onClose} />;
}

function InterviewNotice({
  message,
  onClose,
  onRetry,
}: {
  message: string;
  onClose: () => void;
  onRetry?: () => Promise<void>;
}) {
  return (
    <PanelShell title="面试分身" variant="interview" onClose={onClose}>
      <div className="interview-onboarding-notice" role="status">
        <p>{message}</p>
        {onRetry ? (
          <SurfaceButton onClick={() => void onRetry()} variant="primary">
            重新读取
          </SurfaceButton>
        ) : null}
      </div>
    </PanelShell>
  );
}
