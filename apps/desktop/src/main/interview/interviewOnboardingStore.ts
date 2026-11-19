import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  INTERVIEW_ONBOARDING_STATE_VERSION,
  INTERVIEW_PROJECT_LOCATION_MAX_LENGTH,
  INTERVIEW_PROJECT_NAME_MAX_LENGTH,
  INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH,
  INTERVIEW_PROJECTS_MAX,
  INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH,
  INTERVIEW_RESUME_PATH_MAX_LENGTH,
  INTERVIEW_RESUME_TEXT_MAX_CHARS,
  type InterviewOnboardingPatch,
  type InterviewOnboardingProject,
  type InterviewOnboardingState,
  type InterviewProfileSeed,
  type InterviewProjectAddRequest,
} from "@answra/shared";
import { applyPatch, coerceState, defaultState, isLegacyState } from "./interviewOnboardingState";
import { writeInitialProfileDocument } from "./interviewProfileDocument";

const STATE_FILE = "wizard.json";
const LEGACY_STATE_FILE = "onboarding.json";
const RESUMES_DIR = "resumes";
const STATE_VERSION = INTERVIEW_ONBOARDING_STATE_VERSION;

export interface InterviewOnboardingStoreOptions {
  dataRoot: string;
  now?: () => Date;
}

export type InterviewResumeImportInput =
  | { fileName: string; sourcePath: string }
  | { fileName: string; text: string };

export interface InterviewOnboardingStore {
  read(): Promise<InterviewOnboardingState>;
  readSeed(): Promise<InterviewProfileSeed>;
  importResume(input: InterviewResumeImportInput): Promise<InterviewOnboardingState>;
  update(patch: InterviewOnboardingPatch): Promise<InterviewOnboardingState>;
  addProject(request: InterviewProjectAddRequest): Promise<InterviewOnboardingState>;
  complete(): Promise<InterviewOnboardingState>;
  skip(): Promise<InterviewOnboardingState>;
  reopen(): Promise<InterviewOnboardingState>;
}

/**
 * 面试首次引导的唯一写入方：只保存简历路径、手动录入的项目与目标岗位。
 * 状态文件只是向导进度；完成时若画像不存在，创建首份 profile.xml，之后由 AI 维护。
 */
export function createInterviewOnboardingStore({
  dataRoot,
  now = () => new Date(),
}: InterviewOnboardingStoreOptions): InterviewOnboardingStore {
  const statePath = path.join(dataRoot, STATE_FILE);
  const legacyStatePath = path.join(dataRoot, LEGACY_STATE_FILE);
  const resumesDir = path.join(dataRoot, RESUMES_DIR);

  async function read(): Promise<InterviewOnboardingState> {
    try {
      const loaded = await readStateText();
      if (!loaded) return defaultState(now());
      const parsed = JSON.parse(loaded.text) as unknown;
      const state = coerceState(parsed, resumesDir);
      if (loaded.legacy || isLegacyState(parsed)) {
        await writeState(state).catch((error: unknown) => {
          console.warn("[interview-onboarding] 旧状态迁移失败", error);
        });
      }
      return state;
    } catch (error) {
      if (isMissingFile(error)) return defaultState(now());
      console.warn("[interview-onboarding] 状态文件不可读，回退到未开始", error);
      return defaultState(now());
    }
  }

  async function readStateText(): Promise<{ text: string; legacy: boolean } | null> {
    try {
      return { text: await readFile(statePath, "utf8"), legacy: false };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    try {
      return { text: await readFile(legacyStatePath, "utf8"), legacy: true };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async function readSeed(): Promise<InterviewProfileSeed> {
    const state = await read();
    return {
      targetRole: state.targetRole,
      resume: state.resume,
      projects: state.projects.filter((project) => state.selectedProjectIds.includes(project.id)),
      updatedAt: state.updatedAt,
    };
  }

  async function importResume(
    input: InterviewResumeImportInput,
  ): Promise<InterviewOnboardingState> {
    const fileName = normalizeFileName(input.fileName);
    const current = await read();
    const previous = current.resume;
    const id = randomUUID();
    const sourcePath =
      "text" in input
        ? await writeManagedResumeText(id, input.text)
        : normalizeSourcePath(input.sourcePath);
    const next: InterviewOnboardingState = {
      ...current,
      version: STATE_VERSION,
      status: "pending",
      step: "projects",
      resume: { id, fileName, sourcePath },
      updatedAt: now().toISOString(),
    };
    await writeState(next);
    if (previous && previous.sourcePath !== sourcePath)
      await removeManagedResume(previous.sourcePath);
    return next;
  }

  async function writeManagedResumeText(id: string, rawText: string): Promise<string> {
    const text = rawText.trim();
    if (!text || text.length > INTERVIEW_RESUME_TEXT_MAX_CHARS)
      throw new Error("简历内容为空或过大");
    await mkdir(resumesDir, { recursive: true });
    const sourcePath = path.join(resumesDir, `${id}.txt`);
    await writeFile(sourcePath, text, "utf8");
    return sourcePath;
  }

  async function removeManagedResume(sourcePath: string): Promise<void> {
    if (!isInside(resumesDir, sourcePath)) return;
    await rm(sourcePath, { force: true }).catch((error: unknown) => {
      console.warn("[interview-onboarding] 旧简历清理失败", error);
    });
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
    if (current.status !== "pending") return current;
    const name = request.name.trim();
    if (!name || name.length > INTERVIEW_PROJECT_NAME_MAX_LENGTH)
      throw new Error("项目名称无效或过长");
    const location = request.location?.trim();
    if (location && location.length > INTERVIEW_PROJECT_LOCATION_MAX_LENGTH)
      throw new Error("项目位置过长");
    if (current.projects.length >= INTERVIEW_PROJECTS_MAX) throw new Error("项目数量已达上限");
    const summary = request.summary?.trim().slice(0, INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH);
    const project: InterviewOnboardingProject = {
      id: `manual:${randomUUID()}`,
      name,
      ...(location ? { location } : {}),
      ...(summary ? { summary } : {}),
    };
    const next: InterviewOnboardingState = {
      ...current,
      step: "projects",
      projects: [...current.projects, project],
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
    await writeInitialProfileDocument(dataRoot, next);
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
      step: current.step,
      updatedAt: now().toISOString(),
    };
    await writeState(next);
    return next;
  }

  async function writeState(state: InterviewOnboardingState): Promise<void> {
    await mkdir(dataRoot, { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
      await rename(tempPath, statePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  return { read, readSeed, importResume, update, addProject, complete, skip, reopen };
}

function normalizeFileName(value: string): string {
  const base = path.basename(value.trim());
  if (!base) throw new Error("简历文件名无效");
  return base.slice(0, INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH);
}

function normalizeSourcePath(value: string): string {
  const sourcePath = value.trim();
  if (!sourcePath || sourcePath.length > INTERVIEW_RESUME_PATH_MAX_LENGTH)
    throw new Error("简历路径无效");
  if (!path.isAbsolute(sourcePath)) throw new Error("简历路径必须是绝对路径");
  return sourcePath;
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
