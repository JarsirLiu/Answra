import {
  INTERVIEW_PROJECT_NAME_MAX_LENGTH,
  INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH,
  INTERVIEW_TARGET_ROLE_MAX_LENGTH,
  type InterviewOnboardingState,
  type InterviewProjectAddRequest,
  type InterviewResumeImportRequest,
} from "@answra/shared";
import { FileText, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { SurfaceButton } from "../../components/controls/SurfaceButton";
import { PanelShell } from "../../components/panels/PanelShell";
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

/** 面试首次引导的三步产品 chrome；不接 Bot，也不在客户端生成任何档案事实。 */
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

  function complete(): Promise<void> {
    return perform(async () => {
      await onUpdate({ step: "ready", selectedProjectIds: [...selected], targetRole });
      await onComplete();
    });
  }

  return (
    <PanelShell title="完善面试资料" variant="interview" onClose={onClose}>
      <div className="interview-onboarding" aria-busy={busy}>
        <div className="interview-onboarding-progress">
          {["简历", "项目", "制作"].map((label, index) => (
            <span
              className={`interview-onboarding-step${index <= stepIndex ? " is-done" : ""}${index === stepIndex ? " is-current" : ""}`}
              key={label}
            >
              <span aria-hidden="true" className="interview-onboarding-dot" />
              {label}
            </span>
          ))}
        </div>

        {error ? (
          <div className="interview-onboarding-error" role="alert">
            {error}
          </div>
        ) : null}

        {state.step === "resume" ? (
          <section
            aria-labelledby="interview-onboarding-resume-title"
            className="interview-onboarding-body"
          >
            <p className="interview-onboarding-eyebrow">面试准备 · 1 / 3</p>
            <h2 id="interview-onboarding-resume-title">先让面试分身认识你</h2>
            <p className="interview-onboarding-lead">
              选一份简历，挑出你想重点讲的项目。它只用你的真实经历帮你，不编造。
            </p>
            <ul className="interview-onboarding-points">
              <li>首版支持 .md 和 .txt；内容只保存在本机。</li>
              <li>识别不到项目时，可以手动补一个。</li>
              <li>随时可以稍后再说，不影响进入面试演练。</li>
            </ul>

            {state.resume ? (
              <div className="interview-onboarding-file">
                <FileText aria-hidden="true" size={18} />
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
                  rows={5}
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

            <div className="interview-onboarding-actions">
              <SurfaceButton
                disabled={busy}
                onClick={() => void (state.resume ? continueFromResume() : pickResume())}
                size="lg"
                variant="primary"
              >
                {state.resume ? "继续选择项目" : "选择简历"}
              </SurfaceButton>
              {state.resume ? (
                <SurfaceButton disabled={busy} onClick={() => void pickResume()} variant="quiet">
                  换一份简历
                </SurfaceButton>
              ) : (
                <SurfaceButton onClick={() => setPasteOpen(true)} variant="quiet">
                  粘贴简历文本
                </SurfaceButton>
              )}
              <SurfaceButton disabled={busy} onClick={() => void perform(onSkip)} variant="quiet">
                稍后再说
              </SurfaceButton>
            </div>
          </section>
        ) : null}

        {state.step === "projects" ? (
          <section
            aria-labelledby="interview-onboarding-projects-title"
            className="interview-onboarding-body"
          >
            <p className="interview-onboarding-eyebrow">面试准备 · 2 / 3</p>
            <h2 id="interview-onboarding-projects-title">挑出你想重点讲的项目</h2>
            <p className="interview-onboarding-lead">
              默认全选。取消不想展开的项目，之后仍可在向导里补充。
            </p>

            {projects.length === 0 ? (
              <div className="interview-onboarding-empty">
                <p>没有从这份简历里识别到项目。</p>
                <p>可以重新选择简历，或者先手动加一个。</p>
              </div>
            ) : (
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
                              {[project.role, project.period].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                          {project.summary ? <span>{project.summary}</span> : null}
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
            )}

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
                  <SurfaceButton
                    disabled={busy || !addName.trim()}
                    onClick={() => void addProject()}
                    variant="primary"
                  >
                    添加项目
                  </SurfaceButton>
                  <SurfaceButton onClick={() => setAddOpen(false)} variant="quiet">
                    取消
                  </SurfaceButton>
                </div>
              </div>
            ) : (
              <SurfaceButton onClick={() => setAddOpen(true)} variant="quiet">
                <Plus aria-hidden="true" size={14} />
                添加简历里没有的项目
              </SurfaceButton>
            )}

            <div className="interview-onboarding-actions">
              <SurfaceButton disabled={busy} onClick={() => void backToResume()} variant="quiet">
                上一步
              </SurfaceButton>
              <SurfaceButton
                disabled={busy}
                onClick={() => void continueFromProjects()}
                size="lg"
                variant="primary"
              >
                继续
              </SurfaceButton>
            </div>
          </section>
        ) : null}

        {state.step === "ready" ? (
          <section
            aria-labelledby="interview-onboarding-ready-title"
            className="interview-onboarding-body"
          >
            <p className="interview-onboarding-eyebrow">面试准备 · 3 / 3</p>
            <h2 id="interview-onboarding-ready-title">开始制作面试分身</h2>
            <p className="interview-onboarding-lead">
              简历和项目已准备好。接下来会据此制作候选人档案；当前版本先保存你的选择。
            </p>

            <div className="interview-onboarding-summary">
              <div>
                <span>简历</span>
                <strong>{state.resume?.fileName ?? "未选择"}</strong>
              </div>
              <div>
                <span>重点项目</span>
                <strong>{selectedProjects.length} 个</strong>
              </div>
              {selectedProjects.length > 0 ? (
                <ul>
                  {selectedProjects.map((project) => (
                    <li key={project.id}>{project.name}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            <label
              className="interview-onboarding-field"
              htmlFor="interview-onboarding-target-role"
            >
              目标岗位（可选）
              <input
                id="interview-onboarding-target-role"
                maxLength={INTERVIEW_TARGET_ROLE_MAX_LENGTH}
                onChange={(event) => setTargetRole(event.target.value)}
                placeholder="例如：高级前端工程师"
                value={targetRole}
              />
            </label>

            <div className="interview-onboarding-actions">
              <SurfaceButton
                disabled={busy}
                onClick={() => void complete()}
                size="lg"
                variant="primary"
              >
                保存并进入面试演练
              </SurfaceButton>
              <SurfaceButton disabled={busy} onClick={() => void backToProjects()} variant="quiet">
                上一步
              </SurfaceButton>
            </div>
          </section>
        ) : null}
      </div>
    </PanelShell>
  );
}
