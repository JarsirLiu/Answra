/** 面试引导状态的解析、默认值与补丁应用；只处理纯数据，不读写文件。 */
import path from "node:path";
import {
  INTERVIEW_ONBOARDING_STATE_VERSION,
  INTERVIEW_ONBOARDING_STEPS,
  INTERVIEW_PROJECT_ID_MAX_LENGTH,
  INTERVIEW_PROJECT_LOCATION_MAX_LENGTH,
  INTERVIEW_PROJECT_NAME_MAX_LENGTH,
  INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH,
  INTERVIEW_PROJECTS_MAX,
  INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH,
  INTERVIEW_RESUME_PATH_MAX_LENGTH,
  INTERVIEW_TARGET_ROLE_MAX_LENGTH,
  type InterviewOnboardingPatch,
  type InterviewOnboardingProject,
  type InterviewOnboardingResume,
  type InterviewOnboardingState,
  isInterviewOnboardingStatus,
  isInterviewOnboardingStep,
} from "@answra/shared";

export function applyPatch(
  current: InterviewOnboardingState,
  patch: InterviewOnboardingPatch,
  date: Date,
): InterviewOnboardingState {
  const step = isInterviewOnboardingStep(patch.step) ? patch.step : current.step;
  const availableIds = new Set(current.projects.map((project) => project.id));
  const selectedProjectIds =
    patch.selectedProjectIds === undefined
      ? current.selectedProjectIds
      : coerceSelectedProjectIds(patch.selectedProjectIds, availableIds);
  const targetRole =
    patch.targetRole === undefined
      ? current.targetRole
      : patch.targetRole.trim().slice(0, INTERVIEW_TARGET_ROLE_MAX_LENGTH);
  return {
    ...current,
    step,
    selectedProjectIds,
    targetRole,
    updatedAt: date.toISOString(),
  };
}

export function isLegacyState(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    (value as { version?: unknown }).version === 1
  );
}

export function coerceState(value: unknown, resumesDir: string): InterviewOnboardingState {
  if (typeof value !== "object" || value === null) throw new Error("invalid state");
  const raw = value as { version?: unknown } & Partial<Omit<InterviewOnboardingState, "version">>;
  if (raw.version === 1) return migrateVersion1(value, resumesDir);
  if (raw.version !== INTERVIEW_ONBOARDING_STATE_VERSION) throw new Error("unknown state version");
  if (!isInterviewOnboardingStatus(raw.status)) throw new Error("invalid status");
  if (!isInterviewOnboardingStep(raw.step)) throw new Error("invalid step");
  const resume = coerceResume(raw.resume);
  const projects = coerceProjects(raw.projects);
  const selectedProjectIds = coerceSelectedProjectIds(
    raw.selectedProjectIds,
    new Set(projects.map((project) => project.id)),
  );
  return {
    version: INTERVIEW_ONBOARDING_STATE_VERSION,
    status: raw.status,
    step: raw.step,
    resume,
    projects,
    selectedProjectIds,
    targetRole:
      typeof raw.targetRole === "string"
        ? raw.targetRole.slice(0, INTERVIEW_TARGET_ROLE_MAX_LENGTH)
        : "",
    rehearsalStartedAt: coerceRehearsalStartedAt(raw.rehearsalStartedAt),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
}

/** v1 把项目嵌在 resume 下并保存正文副本；迁移时把正文副本路径当作 sourcePath。 */
function migrateVersion1(value: unknown, resumesDir: string): InterviewOnboardingState {
  const raw = value as {
    status?: unknown;
    step?: unknown;
    resume?: unknown;
    selectedProjectIds?: unknown;
    targetRole?: unknown;
    updatedAt?: unknown;
  };
  if (!isInterviewOnboardingStatus(raw.status)) throw new Error("invalid status");
  if (!isInterviewOnboardingStep(raw.step)) throw new Error("invalid step");
  const legacyResume = typeof raw.resume === "object" && raw.resume !== null ? raw.resume : null;
  const legacyId =
    legacyResume && "id" in legacyResume && typeof legacyResume.id === "string"
      ? legacyResume.id
      : undefined;
  const legacyFileName =
    legacyResume && "fileName" in legacyResume && typeof legacyResume.fileName === "string"
      ? legacyResume.fileName
      : undefined;
  const resume: InterviewOnboardingResume | null =
    legacyId && legacyFileName
      ? {
          id: legacyId,
          fileName: legacyFileName.slice(0, INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH),
          sourcePath: managedTextPath(resumesDir, legacyId),
        }
      : null;
  const legacyProjects =
    legacyResume && "projects" in legacyResume
      ? coerceProjects((legacyResume as { projects?: unknown }).projects)
      : [];
  const selectedProjectIds = coerceSelectedProjectIds(
    raw.selectedProjectIds,
    new Set(legacyProjects.map((project) => project.id)),
  );
  return {
    version: INTERVIEW_ONBOARDING_STATE_VERSION,
    status: raw.status,
    step: raw.step,
    resume,
    projects: legacyProjects,
    selectedProjectIds,
    targetRole:
      typeof raw.targetRole === "string"
        ? raw.targetRole.slice(0, INTERVIEW_TARGET_ROLE_MAX_LENGTH)
        : "",
    rehearsalStartedAt: null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
}

function managedTextPath(resumesDir: string, id: string): string {
  return path.join(resumesDir, `${id}.txt`);
}

function coerceSelectedProjectIds(value: unknown, availableIds: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((id): id is string => typeof id === "string" && availableIds.has(id))),
  ];
}

function coerceResume(value: unknown): InterviewOnboardingResume | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<InterviewOnboardingResume>;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > INTERVIEW_PROJECT_ID_MAX_LENGTH)
    return null;
  if (typeof raw.fileName !== "string" || !raw.fileName) return null;
  if (typeof raw.sourcePath !== "string" || !raw.sourcePath) return null;
  return {
    id: raw.id,
    fileName: raw.fileName.slice(0, INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH),
    sourcePath: raw.sourcePath.slice(0, INTERVIEW_RESUME_PATH_MAX_LENGTH),
  };
}

function coerceProjects(value: unknown): InterviewOnboardingProject[] {
  if (!Array.isArray(value) || value.length > INTERVIEW_PROJECTS_MAX) return [];
  return value
    .map(coerceProject)
    .filter((project): project is InterviewOnboardingProject => project !== undefined);
}

function coerceProject(value: unknown): InterviewOnboardingProject | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<InterviewOnboardingProject>;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > INTERVIEW_PROJECT_ID_MAX_LENGTH)
    return undefined;
  if (
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.length > INTERVIEW_PROJECT_NAME_MAX_LENGTH
  )
    return undefined;
  return {
    id: raw.id,
    name: raw.name,
    ...(typeof raw.location === "string" && raw.location
      ? { location: raw.location.slice(0, INTERVIEW_PROJECT_LOCATION_MAX_LENGTH) }
      : {}),
    ...(typeof raw.summary === "string" && raw.summary
      ? { summary: raw.summary.slice(0, INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH) }
      : {}),
  };
}

export function defaultState(date: Date): InterviewOnboardingState {
  return {
    version: INTERVIEW_ONBOARDING_STATE_VERSION,
    status: "pending",
    step: INTERVIEW_ONBOARDING_STEPS[0],
    resume: null,
    projects: [],
    selectedProjectIds: [],
    targetRole: "",
    rehearsalStartedAt: null,
    updatedAt: date.toISOString(),
  };
}

function coerceRehearsalStartedAt(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
