import { SurfaceButton } from "../components/controls/SurfaceButton";
import { PanelShell } from "../components/panels/PanelShell";
import { InterviewOnboardingPanel } from "../interview/onboarding/InterviewOnboardingPanel";
import { useInterviewOnboarding } from "../interview/onboarding/useInterviewOnboarding";
import "../interview/onboarding/onboarding.css";
import {
  InterviewRehearsalPanel,
  type InterviewRehearsalPanelProps,
} from "./InterviewRehearsalPanel";

/** 面试面板入口：先走首次引导，完成/跳过后才进入原有演练会话。 */
export function InterviewFeaturePanel(props: InterviewRehearsalPanelProps) {
  const onboarding = useInterviewOnboarding(props.platform);

  if (onboarding.loading) {
    return <InterviewOnboardingNotice message="正在读取面试引导…" onClose={props.onClose} />;
  }

  if (onboarding.error && !onboarding.state) {
    return (
      <InterviewOnboardingNotice
        message={onboarding.error}
        onClose={props.onClose}
        onRetry={onboarding.reload}
      />
    );
  }

  if (onboarding.state?.status === "pending") {
    return (
      <InterviewOnboardingPanel
        error={onboarding.error}
        onAddProject={onboarding.addProject}
        onClose={props.onClose}
        onComplete={onboarding.complete}
        onImportResume={onboarding.importResume}
        onPickResume={onboarding.pickResume}
        onSkip={onboarding.skip}
        onUpdate={onboarding.update}
        state={onboarding.state}
      />
    );
  }

  return <InterviewRehearsalPanel {...props} />;
}

function InterviewOnboardingNotice({
  message,
  onClose,
  onRetry,
}: {
  message: string;
  onClose: () => void;
  onRetry?: () => Promise<void>;
}) {
  return (
    <PanelShell title="面试演练" variant="interview" onClose={onClose}>
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
