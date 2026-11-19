import type { InterviewOnboardingState } from "@answra/shared";
import { ClipboardList, FileText, FolderKanban, Target, X } from "lucide-react";
import { IconButton } from "../../components/controls/IconButton";
import { SurfaceButton } from "../../components/controls/SurfaceButton";
import { InterviewOnboardingArt } from "../onboarding/InterviewOnboardingArt";
import "../onboarding/onboarding.css";
import "./avatar.css";

interface InterviewAvatarPanelProps {
  state: InterviewOnboardingState;
  error?: string;
  onClose: () => void;
  onReopen: () => Promise<void>;
}

/** 引导完成或跳过后进入的制作态；Bot 未接入前只展示已保存的资料。 */
export function InterviewAvatarPanel({
  state,
  error,
  onClose,
  onReopen,
}: InterviewAvatarPanelProps) {
  const completed = state.status === "completed";
  const selected = state.projects.filter((project) =>
    state.selectedProjectIds.includes(project.id),
  );
  const hasMaterials = Boolean(state.resume || selected.length > 0 || state.targetRole.trim());
  const showProgress = completed && hasMaterials;
  let title = "还没有面试资料";
  let description = completed ? "进入面试后，AI 会先帮你建立画像。" : "补一份简历，就能开始制作。";
  if (hasMaterials) {
    title = "资料已保存";
    description = "资料已保存；继续完善后再开始制作。";
    if (showProgress) {
      title = "面试分身制作中";
      description = "简历和项目已保存；制作能力接入中。";
    }
  }

  return (
    <section aria-label="面试分身" className="interview-avatar">
      <header className="interview-avatar-top">
        <span className="interview-avatar-brand">面试分身</span>
        <span className="interview-avatar-state">{showProgress ? "制作中" : "待完善"}</span>
        <IconButton icon={X} label="收起面板" onClick={onClose} variant="quiet" />
      </header>

      <div className="interview-avatar-body">
        <div className="interview-avatar-art-slot">
          <InterviewOnboardingArt />
        </div>

        <div className="interview-avatar-copy">
          <h1>{title}</h1>
          <p>{description}</p>
        </div>

        {showProgress ? (
          <ol aria-label="制作进度" className="interview-avatar-steps">
            <li>
              <span className="interview-avatar-step-icon">
                <FileText aria-hidden="true" size={14} />
              </span>
              读取简历
            </li>
            <li>
              <span className="interview-avatar-step-icon">
                <FolderKanban aria-hidden="true" size={14} />
              </span>
              查看项目
            </li>
            <li>
              <span className="interview-avatar-step-icon">
                <ClipboardList aria-hidden="true" size={14} />
              </span>
              整理面试文档
            </li>
          </ol>
        ) : null}

        <div className="interview-avatar-facts">
          <span className="interview-avatar-fact">
            <FileText aria-hidden="true" size={13} />
            <b title={state.resume?.fileName}>{state.resume?.fileName ?? "未选择简历"}</b>
          </span>
          <span className="interview-avatar-fact">
            <FolderKanban aria-hidden="true" size={13} />
            <b>{selected.length} 个项目</b>
          </span>
          <span className="interview-avatar-fact">
            <Target aria-hidden="true" size={13} />
            <b title={state.targetRole || undefined}>{state.targetRole || "岗位未填写"}</b>
          </span>
        </div>

        {error ? (
          <p className="interview-avatar-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="interview-avatar-actions">
          <SurfaceButton
            onClick={() => void onReopen()}
            variant={showProgress ? "default" : "primary"}
          >
            {showProgress ? "修改资料" : hasMaterials ? "继续完善" : "完善面试资料"}
          </SurfaceButton>
        </div>

        {showProgress ? <p className="interview-avatar-note">制作能力接入中</p> : null}
      </div>
    </section>
  );
}
