import { Bot, Sparkles } from "lucide-react";

interface InterviewReadyPosterProps {
  fileName: string | null;
  projects: ReadonlyArray<{ id: string; name: string }>;
}

/** 第三步的候选人档案海报：头像、简历/项目统计和项目胶囊，替代纯文字摘要。 */
export function InterviewReadyPoster({ fileName, projects }: InterviewReadyPosterProps) {
  const visibleProjects = projects.slice(0, 3);
  const hiddenCount = projects.length - visibleProjects.length;

  return (
    <div className="interview-onboarding-poster">
      <div aria-hidden="true" className="interview-onboarding-poster__art">
        <span className="interview-onboarding-poster__glow" />
        <span className="interview-onboarding-poster__ring" />
        <span className="interview-onboarding-poster__avatar">
          <Bot size={26} strokeWidth={1.6} />
        </span>
        <span className="interview-onboarding-poster__badge">
          <Sparkles size={11} strokeWidth={2} />
        </span>
        <span className="interview-onboarding-poster__spark is-one" />
        <span className="interview-onboarding-poster__spark is-two" />
      </div>

      <div className="interview-onboarding-poster__body">
        <span className="interview-onboarding-poster__eyebrow">候选人档案</span>
        <div className="interview-onboarding-poster__stats">
          <div className="interview-onboarding-poster__stat">
            <span>简历</span>
            <strong title={fileName ?? undefined}>{fileName ?? "未选择"}</strong>
          </div>
          <div className="interview-onboarding-poster__stat">
            <span>重点项目</span>
            <strong>{projects.length} 个</strong>
          </div>
        </div>
        <div className="interview-onboarding-poster__chips">
          {visibleProjects.length > 0 ? (
            visibleProjects.map((project) => (
              <span className="interview-onboarding-poster__chip" key={project.id}>
                {project.name}
              </span>
            ))
          ) : (
            <span className="interview-onboarding-poster__chip is-empty">
              还没有选项目，也可以直接制作
            </span>
          )}
          {hiddenCount > 0 ? (
            <span className="interview-onboarding-poster__chip is-more">+{hiddenCount}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
