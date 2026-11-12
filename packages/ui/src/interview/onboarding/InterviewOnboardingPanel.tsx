import {
  INTERVIEW_PROJECT_NAME_MAX_LENGTH,
  INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH,
  INTERVIEW_TARGET_ROLE_MAX_LENGTH,
  type InterviewOnboardingState,
  type InterviewProjectAddRequest,
  type InterviewResumeImportRequest,
} from "@answra/shared";
import { FileSearch, FileText, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../../components/controls/IconButton";
import { SurfaceButton } from "../../components/controls/SurfaceButton";
import { InterviewOnboardingArt } from "./InterviewOnboardingArt";
import { InterviewReadyPoster } from "./InterviewReadyPoster";
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

/** 面试首次引导的广告式弹窗；不接 Bot，也不在客户端生成任何档案事实。 */
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
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addSummary, setAddSummary] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(state.selectedProjectIds));
  const [targetRole, setTargetRole] = useState(state.targetRole);

  useEffect(() => {
    setSelected(new Set(state.selectedProjectIds));
    setTargetRole(state.targetRole);
  }, [state.selectedProjectIds, state.targetRole]);

  const projects = state.resume?.projects ?? [];
  const selectedProjects = projects.filter((project) => selected.has(project.id));
  const stepIndex = state.step === "resume" ? 0 : state.step === "projects" ? 1 : 2;

  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch {
      // 错误已由 useInterviewOnboarding 收敛为 error 文案。
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
    setSelected(new Set(projects.map((project) => project.id)));
  }

  function clearSelected(): void {
    setSelected(new Set());
  }

  function pickResume(): Promise<void> {
    return perform(async () => {
      const cancelled = await onPickResume();
      if (!cancelled) setPasteOpen(false);
    });
  }

  function importResume(): Promise<void> {
    const text = pasteText.trim();
    if (!text) return Promise.resolve();
    return perform(async () => {
      await onImportResume({ fileName: "粘贴的简历.txt", text });
      setPasteText("");
      setPasteOpen(false);
    });
  }

  function addProject(): Promise<void> {
    const name = addName.trim();
    if (!name) return Promise.resolve();
    return perform(async () => {
      await onAddProject({
        name,
        ...(addSummary.trim() ? { summary: addSummary.trim() } : {}),
      });
      setAddName("");
      setAddSummary("");
      setAddOpen(false);
    });
  }

  function continueFromResume(): Promise<void> {
    return perform(() => onUpdate({ step: "projects" }));
  }

  function continueFromProjects(): Promise<void> {
    return perform(() => onUpdate({ step: "ready", selectedProjectIds: [...selected] }));
  }

  function backToResume(): Promise<void> {
    return perform(() => onUpdate({ step: "resume" }));
  }

  function backToProjects(): Promise<void> {
    return perform(() =>
      onUpdate({ step: "projects", selectedProjectIds: [...selected], targetRole }),
    );
  }

  /** 跳过当前步骤；没有简历时不提供跳过入口，避免一步结束整个引导。 */
  function skipStep(): Promise<void> {
    if (state.step === "resume") {
      if (!state.resume) return perform(onSkip);
      return perform(() => onUpdate({ step: "projects" }));
    }
    if (state.step === "projects") {
      return perform(() => onUpdate({ step: "ready", selectedProjectIds: [...selected] }));
    }
    return perform(onSkip);
  }

  function complete(): Promise<void> {
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
                  <span>已识别 {state.resume.projects.length} 个项目</span>
                </div>
              </div>
            ) : null}

            {pasteOpen ? (
              <div className="interview-onboarding-paste">
                <label htmlFor="interview-onboarding-paste-text">粘贴简历文本</label>
                <textarea
                  id="interview-onboarding-paste-text"
                  onChange={(event) => setPasteText(event.target.value)}
                  placeholder="把简历正文粘贴到这里"
                  rows={4}
                  value={pasteText}
                />
                <div className="interview-onboarding-actions">
                  <SurfaceButton
                    disabled={busy || !pasteText.trim()}
                    onClick={() => void importResume()}
                    variant="primary"
                  >
                    导入简历文本
                  </SurfaceButton>
                  <SurfaceButton onClick={() => setPasteOpen(false)} variant="quiet">
                    取消
                  </SurfaceButton>
                </div>
              </div>
            ) : null}

            {!pasteOpen ? (
              <div className="interview-onboarding-actions">
                <SurfaceButton disabled={busy} onClick={() => void pickResume()}>
                  {state.resume ? "换一份简历" : "上传简历"}
                </SurfaceButton>
                <SurfaceButton onClick={() => setPasteOpen(true)} variant="quiet">
                  粘贴文本
                </SurfaceButton>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {state.step === "projects" ? (
        <section
          aria-labelledby="interview-onboarding-projects-title"
          className="interview-onboarding-body"
        >
          <h1 id="interview-onboarding-projects-title">挑出你想重点讲的项目</h1>
          {projects.length > 0 ? (
            <p className="interview-onboarding-lead">默认全选，之后还能补。</p>
          ) : null}

          {projects.length > 0 && state.resume ? (
            <div className="interview-onboarding-source">
              <FileText aria-hidden="true" size={14} />
              <span>{state.resume.fileName}</span>
              <strong>{projects.length} 个项目</strong>
            </div>
          ) : null}

          {projects.length === 0 && !addOpen ? (
            <div className="interview-onboarding-empty">
              <span aria-hidden="true" className="interview-onboarding-empty__art">
                <span className="interview-onboarding-empty__ghost is-back" />
                <span className="interview-onboarding-empty__ghost is-front">
                  <span className="interview-onboarding-empty__line" />
                  <span className="interview-onboarding-empty__line is-short" />
                </span>
                <span className="interview-onboarding-empty__lens">
                  <FileSearch size={16} strokeWidth={1.8} />
                </span>
              </span>
              <strong>{state.resume ? "没识别到项目" : "还没有简历"}</strong>
              <p>{state.resume ? "换份简历，或手动补一个。" : "上传一份简历后再挑项目。"}</p>
              <div className="interview-onboarding-empty__actions">
                <SurfaceButton disabled={busy} onClick={() => void pickResume()} size="sm">
                  {state.resume ? "换份简历" : "上传简历"}
                </SurfaceButton>
                {state.resume ? (
                  <SurfaceButton onClick={() => setAddOpen(true)} size="sm">
                    <Plus aria-hidden="true" size={14} />
                    手动添加
                  </SurfaceButton>
                ) : null}
              </div>
            </div>
          ) : projects.length > 0 ? (
            <>
              <div className="interview-onboarding-selection-tools">
                <span>
                  已选 {selectedProjects.length} / {projects.length}
                </span>
                <SurfaceButton onClick={selectAll} size="sm" variant="quiet">
                  全选
                </SurfaceButton>
                <SurfaceButton onClick={clearSelected} size="sm" variant="quiet">
                  清空
                </SurfaceButton>
              </div>
              <div className="interview-project-list">
                {projects.map((project) => {
                  const checkboxId = `interview-project-${project.id}`;
                  return (
                    <div
                      className={`interview-project-card${selected.has(project.id) ? " is-selected" : ""}`}
                      key={project.id}
                    >
                      <input
                        checked={selected.has(project.id)}
                        id={checkboxId}
                        onChange={() => toggleProject(project.id)}
                        type="checkbox"
                      />
                      <span className="interview-project-content">
                        <label className="interview-project-title" htmlFor={checkboxId}>
                          {project.name}
                        </label>
                        {project.role || project.period ? (
                          <span className="interview-project-meta">
                            {project.role ? (
                              <span className="interview-project-chip">{project.role}</span>
                            ) : null}
                            {project.period ? (
                              <span className="interview-project-chip is-quiet">
                                {project.period}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                        {project.summary ? (
                          <span className="interview-project-summary">{project.summary}</span>
                        ) : null}
                        {project.evidence ? (
                          <details>
                            <summary>查看原文片段</summary>
                            <pre>{project.evidence}</pre>
                          </details>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {addOpen ? (
            <div className="interview-onboarding-paste">
              <label htmlFor="interview-onboarding-project-name">项目名称</label>
              <input
                id="interview-onboarding-project-name"
                maxLength={INTERVIEW_PROJECT_NAME_MAX_LENGTH}
                onChange={(event) => setAddName(event.target.value)}
                value={addName}
              />
              <label htmlFor="interview-onboarding-project-summary">一句话说明（可选）</label>
              <textarea
                id="interview-onboarding-project-summary"
                maxLength={INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH}
                onChange={(event) => setAddSummary(event.target.value)}
                rows={2}
                value={addSummary}
              />
              <div className="interview-onboarding-actions">
                <SurfaceButton disabled={busy || !addName.trim()} onClick={() => void addProject()}>
                  添加项目
                </SurfaceButton>
                <SurfaceButton onClick={() => setAddOpen(false)} variant="quiet">
                  取消
                </SurfaceButton>
              </div>
            </div>
          ) : projects.length > 0 ? (
            <SurfaceButton onClick={() => setAddOpen(true)} variant="quiet">
              <Plus aria-hidden="true" size={14} />
              手动加一个项目
            </SurfaceButton>
          ) : null}
        </section>
      ) : null}

      {state.step === "ready" ? (
        <section
          aria-labelledby="interview-onboarding-ready-title"
          className="interview-onboarding-body interview-onboarding-ready"
        >
          <h1 id="interview-onboarding-ready-title">开始制作面试分身</h1>
          <p className="interview-onboarding-lead">最后确认一下，马上开始制作。</p>

          <InterviewReadyPoster
            fileName={state.resume?.fileName ?? null}
            projects={selectedProjects}
          />

          <label className="interview-onboarding-field" htmlFor="interview-onboarding-target-role">
            目标岗位（可选）
            <input
              id="interview-onboarding-target-role"
              maxLength={INTERVIEW_TARGET_ROLE_MAX_LENGTH}
              onChange={(event) => setTargetRole(event.target.value)}
              placeholder="例如：高级前端工程师"
              value={targetRole}
            />
          </label>
        </section>
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
