/** 引导第一步：选择或粘贴简历；只展示与触发选择，不保存简历事实。 */
import type { InterviewOnboardingState } from "@answra/shared";
import { FileText } from "lucide-react";
import { SurfaceButton } from "../../../components/controls/SurfaceButton";
import { InterviewOnboardingArt } from "../InterviewOnboardingArt";

interface InterviewOnboardingResumeStepProps {
  state: InterviewOnboardingState;
  busy: boolean;
  paste: {
    open: boolean;
    text: string;
    onOpen: () => void;
    onClose: () => void;
    onChange: (value: string) => void;
  };
  onPickResume: () => void;
  onImportResume: () => void;
}

export function InterviewOnboardingResumeStep({
  state,
  busy,
  paste,
  onPickResume,
  onImportResume,
}: InterviewOnboardingResumeStepProps) {
  return (
    <section
      aria-labelledby="interview-onboarding-resume-title"
      className="interview-onboarding-hero"
    >
      <div className="interview-onboarding-art-slot">
        <InterviewOnboardingArt />
      </div>
      <div className="interview-onboarding-copy">
        <h1 id="interview-onboarding-resume-title">先让面试分身认识你</h1>
        <p className="interview-onboarding-lead">用真实简历，讲你真正做过的项目。</p>

        {state.resume ? (
          <div className="interview-onboarding-file">
            <FileText aria-hidden="true" size={16} />
            <div>
              <strong>{state.resume.fileName}</strong>
              <span title={state.resume.sourcePath}>制作时由 AI 读取这份简历</span>
            </div>
          </div>
        ) : null}

        {paste.open ? (
          <div className="interview-onboarding-paste">
            <label htmlFor="interview-onboarding-paste-text">粘贴简历文本</label>
            <textarea
              id="interview-onboarding-paste-text"
              onChange={(event) => paste.onChange(event.target.value)}
              placeholder="把简历正文粘贴到这里"
              rows={4}
              value={paste.text}
            />
            <div className="interview-onboarding-actions">
              <SurfaceButton
                disabled={busy || !paste.text.trim()}
                onClick={onImportResume}
                variant="primary"
              >
                导入简历文本
              </SurfaceButton>
              <SurfaceButton onClick={paste.onClose} variant="quiet">
                取消
              </SurfaceButton>
            </div>
          </div>
        ) : null}

        {!paste.open ? (
          <div className="interview-onboarding-actions">
            <SurfaceButton disabled={busy} onClick={onPickResume}>
              {state.resume ? "换一份简历" : "上传简历"}
            </SurfaceButton>
            <SurfaceButton onClick={paste.onOpen} variant="quiet">
              粘贴文本
            </SurfaceButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}
