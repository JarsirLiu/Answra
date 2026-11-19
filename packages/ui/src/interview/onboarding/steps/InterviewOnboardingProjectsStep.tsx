/** 引导第二步：选择项目或手动补充项目；添加表单状态留在本步骤。 */
import {
  INTERVIEW_PROJECT_LOCATION_MAX_LENGTH,
  INTERVIEW_PROJECT_NAME_MAX_LENGTH,
  INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH,
  type InterviewOnboardingState,
  type InterviewProjectAddRequest,
} from "@answra/shared";
import { FileSearch, FileText, Plus } from "lucide-react";
import { useState } from "react";
import { SurfaceButton } from "../../../components/controls/SurfaceButton";

interface InterviewOnboardingProjectsStepProps {
  state: InterviewOnboardingState;
  busy: boolean;
  selected: ReadonlySet<string>;
  onToggleProject: (id: string) => void;
  onSelectAll: () => void;
  onClearSelected: () => void;
  onAddProject: (request: InterviewProjectAddRequest) => Promise<void>;
  onPickResume: () => void;
  runAction: (action: () => Promise<void>) => Promise<boolean>;
}

export function InterviewOnboardingProjectsStep({
  state,
  busy,
  selected,
  onToggleProject,
  onSelectAll,
  onClearSelected,
  onAddProject,
  onPickResume,
  runAction,
}: InterviewOnboardingProjectsStepProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addLocation, setAddLocation] = useState("");
  const [addSummary, setAddSummary] = useState("");
  const projects = state.projects;
  const selectedProjects = projects.filter((project) => selected.has(project.id));

  async function addProject(): Promise<void> {
    const name = addName.trim();
    if (!name) return;
    const added = await runAction(() =>
      onAddProject({
        name,
        ...(addLocation.trim() ? { location: addLocation.trim() } : {}),
        ...(addSummary.trim() ? { summary: addSummary.trim() } : {}),
      }),
    );
    if (!added) return;
    setAddName("");
    setAddLocation("");
    setAddSummary("");
    setAddOpen(false);
  }

  return (
    <section
      aria-labelledby="interview-onboarding-projects-title"
      className="interview-onboarding-body"
    >
      <h1 id="interview-onboarding-projects-title">挑出你想重点讲的项目</h1>
      <p className="interview-onboarding-lead">手动补上项目并写清代码位置，制作时 AI 会去读。</p>

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
          <strong>还没有项目</strong>
          <p>手动补一个，写清仓库地址或本地路径。</p>
          <div className="interview-onboarding-empty__actions">
            {state.resume ? (
              <SurfaceButton disabled={busy} onClick={onPickResume} size="sm">
                换份简历
              </SurfaceButton>
            ) : null}
            <SurfaceButton onClick={() => setAddOpen(true)} size="sm">
              <Plus aria-hidden="true" size={14} />
              手动添加
            </SurfaceButton>
          </div>
        </div>
      ) : projects.length > 0 ? (
        <>
          <div className="interview-onboarding-selection-tools">
            <span>
              已选 {selectedProjects.length} / {projects.length}
            </span>
            <SurfaceButton onClick={onSelectAll} size="sm" variant="quiet">
              全选
            </SurfaceButton>
            <SurfaceButton onClick={onClearSelected} size="sm" variant="quiet">
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
                    onChange={() => onToggleProject(project.id)}
                    type="checkbox"
                  />
                  <span className="interview-project-content">
                    <label className="interview-project-title" htmlFor={checkboxId}>
                      {project.name}
                    </label>
                    {project.location ? (
                      <span className="interview-project-meta">
                        <span className="interview-project-chip is-quiet" title={project.location}>
                          {project.location}
                        </span>
                      </span>
                    ) : null}
                    {project.summary ? (
                      <span className="interview-project-summary">{project.summary}</span>
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
          <label htmlFor="interview-onboarding-project-location">
            位置（仓库地址或本地路径，可选）
          </label>
          <input
            id="interview-onboarding-project-location"
            maxLength={INTERVIEW_PROJECT_LOCATION_MAX_LENGTH}
            onChange={(event) => setAddLocation(event.target.value)}
            placeholder="例如：https://github.com/me/project 或 D:\\code\\project"
            value={addLocation}
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
  );
}
