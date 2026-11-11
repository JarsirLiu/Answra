import {
  INTERVIEW_PROJECT_ID_MAX_LENGTH,
  INTERVIEW_PROJECT_NAME_MAX_LENGTH,
  INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH,
  INTERVIEW_PROJECTS_MAX,
  INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH,
  INTERVIEW_RESUME_TEXT_MAX_CHARS,
  INTERVIEW_TARGET_ROLE_MAX_LENGTH,
  InterviewChannels,
  type InterviewOnboardingPatch,
  type InterviewProjectAddRequest,
  type InterviewResumeImportRequest,
  isInterviewOnboardingStep,
} from "@answra/shared";
import { ipcMain } from "electron";
import { getWindow, isWindowFromSender } from "../window";
import type { InterviewOnboardingStore } from "./interviewOnboardingStore";

export interface InterviewOnboardingIpcOptions {
  store: InterviewOnboardingStore;
  pickResumeFile: () => Promise<{ fileName: string; text: string } | null>;
}

/** 面试首次引导 IPC：来源、载荷校验全部在 main 边界完成，preload 只转发。 */
export function registerInterviewOnboardingIpc({
  store,
  pickResumeFile,
}: InterviewOnboardingIpcOptions) {
  function assertSender(event: Electron.IpcMainInvokeEvent): void {
    if (!isWindowFromSender(getWindow(), event)) throw new Error("非法调用");
  }

  ipcMain.handle(InterviewChannels.OnboardingGetState, async (event) => {
    assertSender(event);
    return store.read();
  });

  ipcMain.handle(InterviewChannels.OnboardingPickResume, async (event) => {
    assertSender(event);
    const picked = await pickResumeFile();
    if (!picked) return { cancelled: true, state: await store.read() };
    return { cancelled: false, state: await store.importResume(picked) };
  });

  ipcMain.handle(InterviewChannels.OnboardingImportResume, async (event, payload: unknown) => {
    assertSender(event);
    const request = parseImportRequest(payload);
    return store.importResume({
      fileName: request.fileName ?? "粘贴的简历.txt",
      text: request.text,
    });
  });

  ipcMain.handle(InterviewChannels.OnboardingUpdate, async (event, payload: unknown) => {
    assertSender(event);
    return store.update(parsePatch(payload));
  });

  ipcMain.handle(InterviewChannels.OnboardingAddProject, async (event, payload: unknown) => {
    assertSender(event);
    return store.addProject(parseProject(payload));
  });

  ipcMain.handle(InterviewChannels.OnboardingComplete, async (event) => {
    assertSender(event);
    return store.complete();
  });

  ipcMain.handle(InterviewChannels.OnboardingSkip, async (event) => {
    assertSender(event);
    return store.skip();
  });

  return {
    dispose(): void {
      ipcMain.removeHandler(InterviewChannels.OnboardingGetState);
      ipcMain.removeHandler(InterviewChannels.OnboardingPickResume);
      ipcMain.removeHandler(InterviewChannels.OnboardingImportResume);
      ipcMain.removeHandler(InterviewChannels.OnboardingUpdate);
      ipcMain.removeHandler(InterviewChannels.OnboardingAddProject);
      ipcMain.removeHandler(InterviewChannels.OnboardingComplete);
      ipcMain.removeHandler(InterviewChannels.OnboardingSkip);
    },
  };
}

function parseImportRequest(value: unknown): InterviewResumeImportRequest {
  if (typeof value !== "object" || value === null) throw new Error("简历内容无效");
  const raw = value as { fileName?: unknown; text?: unknown };
  if (typeof raw.text !== "string") throw new Error("简历内容无效");
  const text = raw.text.trim();
  if (!text || text.length > INTERVIEW_RESUME_TEXT_MAX_CHARS) throw new Error("简历内容为空或过大");
  if (raw.fileName !== undefined && typeof raw.fileName !== "string")
    throw new Error("简历文件名无效");
  return {
    ...(raw.fileName
      ? { fileName: raw.fileName.slice(0, INTERVIEW_RESUME_FILE_NAME_MAX_LENGTH) }
      : {}),
    text,
  };
}

function parsePatch(value: unknown): InterviewOnboardingPatch {
  if (typeof value !== "object" || value === null) throw new Error("引导状态无效");
  const raw = value as {
    step?: unknown;
    selectedProjectIds?: unknown;
    targetRole?: unknown;
  };
  if (
    raw.selectedProjectIds !== undefined &&
    (!Array.isArray(raw.selectedProjectIds) ||
      raw.selectedProjectIds.length > INTERVIEW_PROJECTS_MAX ||
      raw.selectedProjectIds.some(
        (id) => typeof id !== "string" || id.length > INTERVIEW_PROJECT_ID_MAX_LENGTH,
      ))
  )
    throw new Error("项目选择无效");
  if (raw.targetRole !== undefined && typeof raw.targetRole !== "string")
    throw new Error("目标岗位无效");
  if (
    typeof raw.targetRole === "string" &&
    raw.targetRole.length > INTERVIEW_TARGET_ROLE_MAX_LENGTH
  )
    throw new Error("目标岗位过长");
  if (raw.step !== undefined && !isInterviewOnboardingStep(raw.step))
    throw new Error("引导步骤无效");
  return {
    ...(raw.step === undefined ? {} : { step: raw.step }),
    ...(raw.selectedProjectIds === undefined
      ? {}
      : { selectedProjectIds: raw.selectedProjectIds as string[] }),
    ...(raw.targetRole === undefined ? {} : { targetRole: raw.targetRole }),
  };
}

function parseProject(value: unknown): InterviewProjectAddRequest {
  if (typeof value !== "object" || value === null) throw new Error("项目内容无效");
  const raw = value as { name?: unknown; summary?: unknown };
  if (
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.length > INTERVIEW_PROJECT_NAME_MAX_LENGTH
  )
    throw new Error("项目名称无效");
  if (raw.summary !== undefined && typeof raw.summary !== "string") throw new Error("项目说明无效");
  if (typeof raw.summary === "string" && raw.summary.length > INTERVIEW_PROJECT_SUMMARY_MAX_LENGTH)
    throw new Error("项目说明过长");
  return {
    name: raw.name.trim(),
    ...(typeof raw.summary === "string" && raw.summary.trim()
      ? { summary: raw.summary.trim() }
      : {}),
  };
}
