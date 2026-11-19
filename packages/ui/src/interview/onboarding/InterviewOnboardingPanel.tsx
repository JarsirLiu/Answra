/** 面试首次引导的外壳：持有跨步骤状态、busy 与导航；步骤视图在 steps/。 */
import type {
  InterviewOnboardingState,
  InterviewProjectAddRequest,
  InterviewResumeImportRequest,
} from "@answra/shared";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../../components/controls/IconButton";
import { SurfaceButton } from "../../components/controls/SurfaceButton";
import { InterviewOnboardingProjectsStep } from "./steps/InterviewOnboardingProjectsStep";
import { InterviewOnboardingReadyStep } from "./steps/InterviewOnboardingReadyStep";
import { InterviewOnboardingResumeStep } from "./steps/InterviewOnboardingResumeStep";
import "./onboarding.css";

interface InterviewOnboardingPanelProps {
  state: InterviewOnboardingState;
  error?: string;
  onPickResume: () => Promise<boolean>;
  onImportResume: (request: InterviewResumeImportRequest) => Promise<void>;
  onUpdate: (patch: {
    step?: InterviewOnboardingState["step"];
    selectedProjectIds?: string[];
    targetRole?: string;
  }) => Promise<void>;
  onAddProject: (request: InterviewProjectAddRequest) => Promise<void>;
  onComplete: () => Promise<void>;
  onSkip: () => Promise<void>;
  onClose: () => void;
}

export function InterviewOnboardingPanel({
  state,
  error,
  onPickResume,
  onImportResume,
  onUpdate,
  onAddProject,
  onComplete,
  onSkip,
  onClose,
}: InterviewOnboardingPanelProps) {
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(state.selectedProjectIds));
  const [targetRole, setTargetRole] = useState(state.targetRole);

  useEffect(() => {
    setSelected(new Set(state.selectedProjectIds));
    setTargetRole(state.targetRole);
  }, [state.selectedProjectIds, state.targetRole]);

  const selectedProjects = state.projects.filter((project) => selected.has(project.id));
  const stepIndex = state.step === "resume" ? 0 : state.step === "projects" ? 1 : 2;

  async function perform(action: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      await action();
      return true;
    } catch {
      // 错误已由 useInterviewOnboarding 收敛为 error 文案。
      return false;
    } finally {
      setBusy(false);
    }
  }

  function toggleProject(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(): void {
    setSelected(new Set(state.projects.map((project) => project.id)));
  }

  function clearSelected(): void {
    setSelected(new Set());
  }

  function pickResume(): Promise<boolean> {
    return perform(async () => {
      const cancelled = await onPickResume();
      if (!cancelled) setPasteOpen(false);
    });
  }

  function importResume(): Promise<boolean> {
    const text = pasteText.trim();
    if (!text) return Promise.resolve(false);
    return perform(async () => {
      await onImportResume({ fileName: "粘贴的简历.txt", text });
      setPasteText("");
      setPasteOpen(false);
    });
  }

  function continueFromResume(): Promise<boolean> {
    return perform(() => onUpdate({ step: "projects" }));
  }

  function continueFromProjects(): Promise<boolean> {
    return perform(() => onUpdate({ step: "ready", selectedProjectIds: [...selected] }));
  }

  function backToResume(): Promise<boolean> {
    return perform(() => onUpdate({ step: "resume" }));
  }

  function backToProjects(): Promise<boolean> {
    return perform(() =>
      onUpdate({ step: "projects", selectedProjectIds: [...selected], targetRole }),
    );
  }

  /** 跳过当前步骤；没有简历时不提供跳过入口，避免一步结束整个引导。 */
  function skipStep(): Promise<boolean> {
    if (state.step === "resume") {
      if (!state.resume) return perform(onSkip);
      return perform(() => onUpdate({ step: "projects" }));
    }
    if (state.step === "projects") {
      return perform(() => onUpdate({ step: "ready", selectedProjectIds: [...selected] }));
    }
    return perform(onSkip);
  }

  function complete(): Promise<boolean> {
    return perform(async () => {
      await onUpdate({ step: "ready", selectedProjectIds: [...selected], targetRole });
      await onComplete();
    });
  }

  return (
    <section
      aria-busy={busy}
      aria-label="完善面试资料"
      className="interview-onboarding"
      data-step={state.step}
    >
      <header className="interview-onboarding-top">
        <div
          aria-label="引导进度"
          aria-valuemax={3}
          aria-valuemin={1}
          aria-valuenow={stepIndex + 1}
          className="interview-onboarding-progress"
          role="progressbar"
        >
          {["简历", "项目", "制作"].map((label, index) => (
            <span
              aria-hidden="true"
              className={`interview-onboarding-dot${index <= stepIndex ? " is-done" : ""}${index === stepIndex ? " is-current" : ""}`}
              key={label}
            />
          ))}
          <span className="interview-onboarding-count">{stepIndex + 1} / 3</span>
        </div>
        <IconButton icon={X} label="收起面板" onClick={onClose} variant="quiet" />
      </header>

      {error ? (
        <div className="interview-onboarding-error" role="alert">
          {error}
        </div>
      ) : null}

      {state.step === "resume" ? (
        <InterviewOnboardingResumeStep
          busy={busy}
          onImportResume={() => void importResume()}
          onPickResume={() => void pickResume()}
          paste={{
            open: pasteOpen,
            text: pasteText,
            onOpen: () => setPasteOpen(true),
            onClose: () => setPasteOpen(false),
            onChange: setPasteText,
          }}
          state={state}
        />
      ) : null}

      {state.step === "projects" ? (
        <InterviewOnboardingProjectsStep
          busy={busy}
          onAddProject={onAddProject}
          onClearSelected={clearSelected}
          onPickResume={() => void pickResume()}
          onSelectAll={selectAll}
          onToggleProject={toggleProject}
          runAction={perform}
          selected={selected}
          state={state}
        />
      ) : null}

      {state.step === "ready" ? (
        <InterviewOnboardingReadyStep
          onTargetRoleChange={setTargetRole}
          selectedProjects={selectedProjects}
          state={state}
          targetRole={targetRole}
        />
      ) : null}

      <footer className="interview-onboarding-footer">
        <div className="interview-onboarding-footer__group">
          {state.step === "resume" ? null : (
            <SurfaceButton
              disabled={busy}
              onClick={() => void (state.step === "projects" ? backToResume() : backToProjects())}
              variant="quiet"
            >
              上一步
            </SurfaceButton>
          )}
          {state.step === "resume" && !state.resume ? null : (
            <SurfaceButton disabled={busy} onClick={() => void skipStep()} variant="quiet">
              {state.step === "ready" ? "跳过引导" : "跳过这一步"}
            </SurfaceButton>
          )}
        </div>

        {state.step === "resume" ? (
          pasteOpen ? null : (
            <SurfaceButton
              disabled={busy}
              onClick={() => void continueFromResume()}
              size="lg"
              variant="primary"
            >
              下一步
            </SurfaceButton>
          )
        ) : state.step === "projects" ? (
          <SurfaceButton
            disabled={busy}
            onClick={() => void continueFromProjects()}
            size="lg"
            variant="primary"
          >
            下一步
          </SurfaceButton>
        ) : (
          <SurfaceButton
            disabled={busy}
            onClick={() => void complete()}
            size="lg"
            variant="primary"
          >
            开始制作面试分身
          </SurfaceButton>
        )}
      </footer>
    </section>
  );
}
