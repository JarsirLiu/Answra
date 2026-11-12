import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  INTERVIEW_ONBOARDING_STEPS,
  INTERVIEW_PROJECT_EVIDENCE_MAX_LENGTH,
  INTERVIEW_PROJECT_ID_MAX_LENGTH,
  INTERVIEW_PROJECT_NAME_MAX_LENGTH,
  INTERVIEW_PROJECT_PERIOD_MAX_LENGTH,
  INTERVIEW_PROJECT_ROLE_MAX_LENGTH,
  INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH,
  INTERVIEW_PROJECTS_MAX,
  INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH,
  INTERVIEW_RESUME_TEXT_MAX_CHARS,
  INTERVIEW_TARGET_ROLE_MAX_LENGTH,
  type InterviewOnboardingPatch,
  type InterviewOnboardingProject,
  type InterviewOnboardingResume,
  type InterviewOnboardingState,
  type InterviewProjectAddRequest,
  isInterviewOnboardingStatus,
  isInterviewOnboardingStep,
} from "@answra/shared";
import { extractResumeProjects } from "./resumeProjects";

const STATE_FILE = "onboarding.json";
const RESUMES_DIR = "resumes";
const STATE_VERSION = 1;

export interface InterviewOnboardingStoreOptions {
  dataRoot: string;
  now?: () => Date;
}

export interface InterviewOnboardingStore {
  read(): Promise<InterviewOnboardingState>;
  importResume(input: { fileName: string; text: string }): Promise<InterviewOnboardingState>;
  update(patch: InterviewOnboardingPatch): Promise<InterviewOnboardingState>;
  addProject(request: InterviewProjectAddRequest): Promise<InterviewOnboardingState>;
  complete(): Promise<InterviewOnboardingState>;
  skip(): Promise<InterviewOnboardingState>;
  reopen(): Promise<InterviewOnboardingState>;
}

/** 面试首次引导的唯一写入方；只保存步骤、项目摘要和目标岗位，不保存简历正文到状态文件。 */
export function createInterviewOnboardingStore({
  dataRoot,
  now = () => new Date(),
}: InterviewOnboardingStoreOptions): InterviewOnboardingStore {
  const statePath = path.join(dataRoot, STATE_FILE);
  const resumesDir = path.join(dataRoot, RESUMES_DIR);

  async function read(): Promise<InterviewOnboardingState> {
    try {
      const raw = await readFile(statePath, "utf8");
      return coerceState(JSON.parse(raw));
    } catch (error) {
      if (isMissingFile(error)) return defaultState(now());
      console.warn("[interview-onboarding] 状态文件不可读，回退到未开始", error);
      return defaultState(now());
    }
  }

  async function importResume(input: {
    fileName: string;
    text: string;
  }): Promise<InterviewOnboardingState> {
    const fileName = normalizeFileName(input.fileName);
    const text = input.text.trim();
    if (!text || text.length > INTERVIEW_RESUME_TEXT_MAX_CHARS)
      throw new Error("简历内容为空或过大");
    const current = await read();
    const previousResumeId = current.resume?.id;
    const id = randomUUID();
    const projects = extractResumeProjects(text).map<InterviewOnboardingProject>(
      (project, index) => ({
        id: `${id}:project:${index + 1}`,
        ...project,
      }),
    );
    await mkdir(resumesDir, { recursive: true });
    await writeFile(path.join(resumesDir, `${id}.txt`), text, "utf8");
    const next: InterviewOnboardingState = {
      version: STATE_VERSION,
      status: "pending",
      step: "projects",
      resume: { id, fileName, projects },
      selectedProjectIds: projects.map((project) => project.id),
      targetRole: current.targetRole,
      updatedAt: now().toISOString(),
    };
    await writeState(next);
    if (previousResumeId && previousResumeId !== id) {
      await rm(path.join(resumesDir, `${previousResumeId}.txt`), { force: true }).catch(
        (error: unknown) => {
          console.warn("[interview-onboarding] 旧简历清理失败", error);
        },
      );
    }
    return next;
  }

  async function update(patch: InterviewOnboardingPatch): Promise<InterviewOnboardingState> {
    const current = await read();
    if (current.status !== "pending") return current;
    const next = applyPatch(current, patch, now());
    await writeState(next);
    return next;
  }

  async function addProject(
    request: InterviewProjectAddRequest,
  ): Promise<InterviewOnboardingState> {
    const current = await read();
    if (current.status !== "pending" || !current.resume) return current;
    const name = request.name.trim();
    if (!name || name.length > INTERVIEW_PROJECT_NAME_MAX_LENGTH)
      throw new Error("项目名称无效或过长");
    if (current.resume.projects.length >= INTERVIEW_PROJECTS_MAX)
      throw new Error("项目数量已达上限");
    const summary = request.summary?.trim().slice(0, INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH);
    const project: InterviewOnboardingProject = {
      id: `manual:${randomUUID()}`,
      name,
      ...(summary ? { summary } : {}),
    };
    const next: InterviewOnboardingState = {
      ...current,
      step: "projects",
      resume: {
        ...current.resume,
        projects: [...current.resume.projects, project],
      },
      selectedProjectIds: [...current.selectedProjectIds, project.id],
      updatedAt: now().toISOString(),
    };
    await writeState(next);
    return next;
  }

  async function complete(): Promise<InterviewOnboardingState> {
    const current = await read();
    if (current.status !== "pending") return current;
    const next: InterviewOnboardingState = {
      ...current,
      status: "completed",
      step: "ready",
      updatedAt: now().toISOString(),
    };
    await writeState(next);
    return next;
  }

  async function skip(): Promise<InterviewOnboardingState> {
    const current = await read();
    if (current.status !== "pending") return current;
    const next: InterviewOnboardingState = {
      ...current,
      status: "skipped",
      updatedAt: now().toISOString(),
    };
    await writeState(next);
    return next;
  }

  async function reopen(): Promise<InterviewOnboardingState> {
    const current = await read();
    if (current.status === "pending") return current;
    const next: InterviewOnboardingState = {
      ...current,
      status: "pending",
      step: current.resume ? current.step : "resume",
      updatedAt: now().toISOString(),
    };
    await writeState(next);
    return next;
  }

  async function writeState(state: InterviewOnboardingState): Promise<void> {
    await mkdir(dataRoot, { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
      await rename(tempPath, statePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  return { read, importResume, update, addProject, complete, skip, reopen };
}

function applyPatch(
  current: InterviewOnboardingState,
  patch: InterviewOnboardingPatch,
  date: Date,
): InterviewOnboardingState {
  if (!current.resume) {
    return { ...current, step: "resume", updatedAt: date.toISOString() };
  }
  const step = isInterviewOnboardingStep(patch.step) ? patch.step : current.step;
  const availableIds = new Set(current.resume.projects.map((project) => project.id));
  const selectedProjectIds =
    patch.selectedProjectIds === undefined
      ? current.selectedProjectIds
      : [...new Set(patch.selectedProjectIds.filter((id) => availableIds.has(id)))];
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

function coerceState(value: unknown): InterviewOnboardingState {
  if (typeof value !== "object" || value === null) throw new Error("invalid state");
  const raw = value as Partial<InterviewOnboardingState>;
  if (raw.version !== STATE_VERSION) throw new Error("unknown state version");
  if (!isInterviewOnboardingStatus(raw.status)) throw new Error("invalid status");
  if (!isInterviewOnboardingStep(raw.step)) throw new Error("invalid step");
  const resume = coerceResume(raw.resume);
  const availableIds = new Set(resume?.projects.map((project) => project.id) ?? []);
  const selectedProjectIds = Array.isArray(raw.selectedProjectIds)
    ? [
        ...new Set(
          raw.selectedProjectIds.filter(
            (id): id is string => typeof id === "string" && availableIds.has(id),
          ),
        ),
      ]
    : [];
  return {
    version: STATE_VERSION,
    status: raw.status,
    step: resume ? raw.step : "resume",
    resume,
    selectedProjectIds,
    targetRole:
      typeof raw.targetRole === "string"
        ? raw.targetRole.slice(0, INTERVIEW_TARGET_ROLE_MAX_LENGTH)
        : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
}

function coerceResume(value: unknown): InterviewOnboardingResume | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<InterviewOnboardingResume>;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > INTERVIEW_PROJECT_ID_MAX_LENGTH)
    return null;
  if (typeof raw.fileName !== "string" || !raw.fileName) return null;
  if (!Array.isArray(raw.projects) || raw.projects.length > INTERVIEW_PROJECTS_MAX) return null;
  const projects = raw.projects
    .map(coerceProject)
    .filter((project): project is InterviewOnboardingProject => project !== undefined);
  return {
    id: raw.id,
    fileName: raw.fileName.slice(0, INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH),
    projects,
  };
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
    ...(typeof raw.role === "string" && raw.role
      ? { role: raw.role.slice(0, INTERVIEW_PROJECT_ROLE_MAX_LENGTH) }
      : {}),
    ...(typeof raw.period === "string" && raw.period
      ? { period: raw.period.slice(0, INTERVIEW_PROJECT_PERIOD_MAX_LENGTH) }
      : {}),
    ...(typeof raw.summary === "string" && raw.summary
      ? { summary: raw.summary.slice(0, INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH) }
      : {}),
    ...(typeof raw.evidence === "string" && raw.evidence
      ? { evidence: raw.evidence.slice(0, INTERVIEW_PROJECT_EVIDENCE_MAX_LENGTH) }
      : {}),
  };
}

function defaultState(date: Date): InterviewOnboardingState {
  return {
    version: STATE_VERSION,
    status: "pending",
    step: INTERVIEW_ONBOARDING_STEPS[0],
    resume: null,
    selectedProjectIds: [],
    targetRole: "",
    updatedAt: date.toISOString(),
  };
}

function normalizeFileName(value: string): string {
  const base = path.basename(value.trim());
  if (!base) throw new Error("简历文件名无效");
  return base.slice(0, INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
