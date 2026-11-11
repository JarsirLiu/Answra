import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInterviewOnboardingStore } from "../src/main/interview/interviewOnboardingStore";

const roots: string[] = [];
const now = () => new Date("2026-11-11T08:00:00.000Z");

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "answra-interview-onboarding-"));
  roots.push(root);
  return {
    root,
    store: createInterviewOnboardingStore({ dataRoot: root, now }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("interview onboarding store", () => {
  it("starts pending at the resume step when no state file exists", async () => {
    const { store } = await setup();

    await expect(store.read()).resolves.toMatchObject({
      version: 1,
      status: "pending",
      step: "resume",
      resume: null,
      selectedProjectIds: [],
      targetRole: "",
    });
  });

  it("imports a resume, stores its raw text separately, and selects extracted projects", async () => {
    const { root, store } = await setup();
    const text = `## 项目经历\n### Answra 桌面助手 | 前端负责人 | 2024.01-2025.06\n- 负责引导面板。\n`;

    const state = await store.importResume({ fileName: "张三简历.md", text });

    expect(state).toMatchObject({
      status: "pending",
      step: "projects",
      resume: { fileName: "张三简历.md" },
    });
    expect(state.resume?.projects).toHaveLength(1);
    expect(state.selectedProjectIds).toEqual([state.resume?.projects[0]?.id]);
    const stateFile = await readFile(path.join(root, "onboarding.json"), "utf8");
    expect(stateFile).not.toContain("## 项目经历");
    const resumeFile = await readFile(
      path.join(root, "resumes", `${state.resume?.id}.txt`),
      "utf8",
    );
    expect(resumeFile).toContain("负责引导面板");
  });

  it("removes the previous raw resume when the user imports a replacement", async () => {
    const { root, store } = await setup();
    const first = await store.importResume({
      fileName: "first.md",
      text: "## 项目经历\n### 项目 A\n- 负责 A。\n",
    });
    const oldPath = path.join(root, "resumes", `${first.resume?.id}.txt`);
    await expect(readFile(oldPath, "utf8")).resolves.toContain("负责 A");

    await store.importResume({
      fileName: "second.md",
      text: "## 项目经历\n### 项目 B\n- 负责 B。\n",
    });

    await expect(readFile(oldPath, "utf8")).rejects.toThrow();
  });

  it("persists step, selection, target role, and manual projects", async () => {
    const { store } = await setup();
    const imported = await store.importResume({
      fileName: "resume.md",
      text: "## 项目经历\n### 项目 A\n- 负责 A。\n",
    });
    const projectId = imported.resume?.projects[0]?.id;
    if (!projectId) throw new Error("project missing");

    const updated = await store.update({
      step: "ready",
      selectedProjectIds: [projectId],
      targetRole: "高级前端工程师",
    });
    expect(updated).toMatchObject({
      step: "ready",
      selectedProjectIds: [projectId],
      targetRole: "高级前端工程师",
    });

    const withManual = await store.addProject({ name: "手写项目", summary: "一句话说明" });
    expect(withManual.resume?.projects.at(-1)).toMatchObject({
      name: "手写项目",
      summary: "一句话说明",
    });
    expect(withManual.selectedProjectIds).toContain(withManual.resume?.projects.at(-1)?.id);
    expect(withManual.step).toBe("projects");
  });

  it("filters project ids that are not in the imported resume", async () => {
    const { store } = await setup();
    await store.importResume({
      fileName: "resume.md",
      text: "## 项目经历\n### 项目 A\n- 负责 A。\n",
    });

    const state = await store.update({ selectedProjectIds: ["missing"] });

    expect(state.selectedProjectIds).toEqual([]);
  });

  it("completes and skips idempotently without downgrading a completed state", async () => {
    const { store } = await setup();
    await store.importResume({
      fileName: "resume.md",
      text: "## 项目经历\n### 项目 A\n- 负责 A。\n",
    });

    await expect(store.complete()).resolves.toMatchObject({ status: "completed", step: "ready" });
    await expect(store.complete()).resolves.toMatchObject({ status: "completed" });
    await expect(store.skip()).resolves.toMatchObject({ status: "completed" });
  });

  it("falls back to pending when the state file is corrupted", async () => {
    const { root, store } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(path.join(root, "onboarding.json"), "{not-json", "utf8");

    await expect(store.read()).resolves.toMatchObject({
      status: "pending",
      step: "resume",
    });
    expect(warn).toHaveBeenCalled();
  });
});
