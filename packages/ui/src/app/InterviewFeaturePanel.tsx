import type { DesktopBridge } from "@answra/shared";
import { useState } from "react";
import { SurfaceButton } from "../components/controls/SurfaceButton";
import { PanelShell } from "../components/panels/PanelShell";
import {
  type InterviewTextChatMode,
  InterviewTextChatPanel,
} from "../interview/chat/InterviewTextChatPanel";
import { InterviewOnboardingPanel } from "../interview/onboarding/InterviewOnboardingPanel";
import { useInterviewOnboarding } from "../interview/onboarding/useInterviewOnboarding";
import "../interview/onboarding/onboarding.css";

interface InterviewFeaturePanelProps {
  platform: DesktopBridge | undefined;
  onClose: () => void;
  /** 本地模型可用时传入：登录失败提示里给出「配置本地模型」替代路径。 */
  onConfigureModel?: () => void;
}

/** 面试入口：未完成时显示引导；完成/跳过后在演练/辅助两个模式间切换。 */
export function InterviewFeaturePanel({
  platform,
  onClose,
  onConfigureModel,
}: InterviewFeaturePanelProps) {
  const onboarding = useInterviewOnboarding(platform);
  const [mode, setMode] = useState<InterviewTextChatMode>("rehearsal");

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
      <InterviewTextChatPanel
        key={mode}
        mode={mode}
        onClose={onClose}
        onModeChange={setMode}
        onConfigureModel={onConfigureModel}
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
