import { InterviewChannels } from "@answra/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const window = { webContents: {} };
  return { handlers, window };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      harness.handlers.set(channel, handler),
    removeHandler: (channel: string) => harness.handlers.delete(channel),
  },
}));

vi.mock("../src/main/window", () => ({
  getWindow: () => harness.window,
  isWindowFromSender: (window: typeof harness.window, event: { sender: unknown }) =>
    event.sender === window.webContents,
}));

import { registerInterviewOnboardingIpc } from "../src/main/interview/interviewOnboardingIpc";
import type { InterviewOnboardingStore } from "../src/main/interview/interviewOnboardingStore";

function state() {
  return {
    version: 1 as const,
    status: "pending" as const,
    step: "resume" as const,
    resume: null,
    selectedProjectIds: [],
    targetRole: "",
    updatedAt: "2026-11-11T08:00:00.000Z",
  };
}

function store(overrides: Partial<InterviewOnboardingStore> = {}): InterviewOnboardingStore {
  return {
    read: vi.fn(async () => state()),
    importResume: vi.fn(async () => state()),
    update: vi.fn(async () => state()),
    addProject: vi.fn(async () => state()),
    complete: vi.fn(async () => ({ ...state(), status: "completed" as const })),
    skip: vi.fn(async () => ({ ...state(), status: "skipped" as const })),
    reopen: vi.fn(async () => state()),
    ...overrides,
  } as InterviewOnboardingStore;
}

function handler(channel: string) {
  const registered = harness.handlers.get(channel);
  if (!registered) throw new Error(`missing handler: ${channel}`);
  return registered;
}

afterEach(() => {
  harness.handlers.clear();
  vi.clearAllMocks();
});

describe("interview onboarding IPC", () => {
  it("rejects callers that are not the main window", async () => {
    const ipc = registerInterviewOnboardingIpc({
      store: store(),
      pickResumeFile: vi.fn(async () => null),
    });

    await expect(handler(InterviewChannels.OnboardingGetState)({ sender: {} })).rejects.toThrow(
      "非法调用",
    );
    ipc.dispose();
  });

  it("keeps the state unchanged when the file dialog is cancelled", async () => {
    const onboarding = store();
    const ipc = registerInterviewOnboardingIpc({
      store: onboarding,
      pickResumeFile: vi.fn(async () => null),
    });

    await expect(
      handler(InterviewChannels.OnboardingPickResume)({ sender: harness.window.webContents }),
    ).resolves.toEqual({ cancelled: true, state: state() });
    ipc.dispose();
  });

  it("imports a picked resume and forwards validated draft changes", async () => {
    const imported = {
      ...state(),
      step: "projects" as const,
      resume: { id: "resume-1", fileName: "resume.md", projects: [] },
    };
    const onboarding = store({
      importResume: vi.fn(async () => imported),
      update: vi.fn(async () => imported),
      addProject: vi.fn(async () => imported),
    });
    const ipc = registerInterviewOnboardingIpc({
      store: onboarding,
      pickResumeFile: vi.fn(async () => ({ fileName: "resume.md", text: "简历正文" })),
    });
    const event = { sender: harness.window.webContents };

    await expect(handler(InterviewChannels.OnboardingPickResume)(event)).resolves.toEqual({
      cancelled: false,
      state: imported,
    });
    expect(onboarding.importResume).toHaveBeenCalledWith({
      fileName: "resume.md",
      text: "简历正文",
    });

    await handler(InterviewChannels.OnboardingUpdate)(event, {
      step: "ready",
      selectedProjectIds: ["project-1"],
      targetRole: "前端",
    });
    expect(onboarding.update).toHaveBeenCalledWith({
      step: "ready",
      selectedProjectIds: ["project-1"],
      targetRole: "前端",
    });

    await handler(InterviewChannels.OnboardingAddProject)(event, {
      name: "手写项目",
      summary: "一句话说明",
    });
    expect(onboarding.addProject).toHaveBeenCalledWith({
      name: "手写项目",
      summary: "一句话说明",
    });
    ipc.dispose();
  });

  it("rejects invalid patches before they reach the store", async () => {
    const onboarding = store();
    const ipc = registerInterviewOnboardingIpc({
      store: onboarding,
      pickResumeFile: vi.fn(async () => null),
    });
    const event = { sender: harness.window.webContents };

    await expect(
      handler(InterviewChannels.OnboardingUpdate)(event, { step: "unknown" }),
    ).rejects.toThrow("引导步骤无效");
    await expect(
      handler(InterviewChannels.OnboardingUpdate)(event, { selectedProjectIds: [42] }),
    ).rejects.toThrow("项目选择无效");
    expect(onboarding.update).not.toHaveBeenCalled();
    ipc.dispose();
  });

  it("completes, skips, and reopens through the store", async () => {
    const onboarding = store();
    const ipc = registerInterviewOnboardingIpc({
      store: onboarding,
      pickResumeFile: vi.fn(async () => null),
    });
    const event = { sender: harness.window.webContents };

    await handler(InterviewChannels.OnboardingComplete)(event);
    await handler(InterviewChannels.OnboardingSkip)(event);
    await handler(InterviewChannels.OnboardingReopen)(event);
    expect(onboarding.complete).toHaveBeenCalledOnce();
    expect(onboarding.skip).toHaveBeenCalledOnce();
    expect(onboarding.reopen).toHaveBeenCalledOnce();
    ipc.dispose();
  });
});
