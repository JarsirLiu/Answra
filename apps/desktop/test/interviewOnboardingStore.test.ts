import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      version: 2,
      status: "pending",
      step: "resume",
      resume: null,
      projects: [],
      selectedProjectIds: [],
      targetRole: "",
      rehearsalStartedAt: null,
    });
  });

  it("records the picked resume path without copying its content", async () => {
    const { root, store } = await setup();
    const sourcePath = path.join(root, "outside", "张三简历.pdf");

    const state = await store.importResume({ fileName: "张三简历.pdf", sourcePath });

    expect(state).toMatchObject({
      status: "pending",
      step: "projects",
      resume: { fileName: "张三简历.pdf", sourcePath },
      projects: [],
    });
    const stateFile = await readFile(path.join(root, "wizard.json"), "utf8");
    expect(JSON.parse(stateFile)).toMatchObject({ resume: { sourcePath } });
    await expect(readFile(path.join(root, "resumes", `${state.resume?.id}.txt`))).rejects.toThrow();
  });

  it("writes pasted resume text to a managed file and stores its path", async () => {
    const { root, store } = await setup();
    const text = "## 项目经历\n### Answra 桌面助手\n- 负责引导面板。\n";

    const state = await store.importResume({ fileName: "粘贴的简历.txt", text });

    const resumeFile = await readFile(
      path.join(root, "resumes", `${state.resume?.id}.txt`),
      "utf8",
    );
    expect(resumeFile).toContain("负责引导面板");
    expect(state.resume?.sourcePath).toBe(path.join(root, "resumes", `${state.resume?.id}.txt`));
  });

  it("removes the previous managed resume text but never deletes a picked source", async () => {
    const { root, store } = await setup();
    const first = await store.importResume({ fileName: "first.txt", text: "第一份简历" });
    const oldManagedPath = first.resume?.sourcePath;
    if (!oldManagedPath) throw new Error("resume missing");
    await expect(readFile(oldManagedPath, "utf8")).resolves.toContain("第一份简历");

    await store.importResume({ fileName: "second.txt", text: "第二份简历" });
    await expect(readFile(oldManagedPath, "utf8")).rejects.toThrow();

    const pickedPath = path.join(root, "真实简历.pdf");
    await writeFile(pickedPath, "pdf-bytes", "utf8");
    await store.importResume({ fileName: "真实简历.pdf", sourcePath: pickedPath });
    await store.importResume({ fileName: "新的简历.md", sourcePath: path.join(root, "新.md") });
    await expect(readFile(pickedPath, "utf8")).resolves.toBe("pdf-bytes");
  });

  it("persists manual projects with location without requiring a resume", async () => {
    const { store } = await setup();

    const withProject = await store.addProject({
      name: "Answra 桌面助手",
      location: "https://github.com/answra/desktop",
      summary: "负责引导与面试面板",
    });

    expect(withProject.step).toBe("projects");
    expect(withProject.resume).toBeNull();
    expect(withProject.projects).toHaveLength(1);
    expect(withProject.projects[0]).toMatchObject({
      name: "Answra 桌面助手",
      location: "https://github.com/answra/desktop",
      summary: "负责引导与面试面板",
    });
    expect(withProject.selectedProjectIds).toEqual([withProject.projects[0]?.id]);
  });

  it("persists step, selection, target role, and new manual projects", async () => {
    const { store } = await setup();
    const added = await store.addProject({ name: "项目 A", location: "D:\\code\\a" });
    const projectId = added.projects[0]?.id;
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
    expect(withManual.projects.at(-1)).toMatchObject({
      name: "手写项目",
      summary: "一句话说明",
    });
    expect(withManual.selectedProjectIds).toContain(withManual.projects.at(-1)?.id);
    expect(withManual.step).toBe("projects");
  });

  it("advances steps without requiring an imported resume", async () => {
    const { store } = await setup();

    const advanced = await store.update({ step: "projects" });
    expect(advanced).toMatchObject({ step: "projects", resume: null });
    await expect(store.read()).resolves.toMatchObject({ step: "projects" });

    await store.update({ step: "ready" });
    await store.complete();
    await expect(store.reopen()).resolves.toMatchObject({ status: "pending", step: "ready" });
  });

  it("filters project ids that do not exist", async () => {
    const { store } = await setup();
    await store.addProject({ name: "项目 A" });

    const state = await store.update({ selectedProjectIds: ["missing"] });

    expect(state.selectedProjectIds).toEqual([]);
  });

  it("exposes only selected projects as the agent seed", async () => {
    const { store } = await setup();
    const first = await store.addProject({ name: "项目 A", location: "D:/code/a" });
    const second = await store.addProject({ name: "项目 B" });
    const firstId = first.projects[0]?.id;
    if (!firstId) throw new Error("project missing");
    await store.update({ step: "ready", selectedProjectIds: [firstId], targetRole: "前端" });

    await expect(store.readSeed()).resolves.toEqual({
      targetRole: "前端",
      resume: null,
      projects: [{ id: firstId, name: "项目 A", location: "D:/code/a" }],
      updatedAt: "2026-11-11T08:00:00.000Z",
    });
    expect(second.projects).toHaveLength(2);
  });

  it("creates the initial profile document on completion", async () => {
    const { root, store } = await setup();
    const sourcePath = path.join(root, "简历.pdf");
    const imported = await store.importResume({ fileName: "简历.pdf", sourcePath });
    const project = await store.addProject({
      name: "Answra 桌面助手",
      location: "https://github.com/answra/desktop",
      summary: "负责引导",
    });
    const projectId = project.projects[0]?.id;
    if (!projectId) throw new Error("project missing");
    await store.update({
      step: "ready",
      selectedProjectIds: [projectId],
      targetRole: "高级前端工程师",
    });

    await store.complete();

    const profile = await readFile(path.join(root, "profile.xml"), "utf8");
    expect(profile).toContain('<profile version="1"');
    expect(profile).toContain("<target-role>高级前端工程师</target-role>");
    expect(profile).toContain(`<file>${imported.resume?.fileName}</file>`);
    expect(profile).toContain(`<path>${sourcePath}</path>`);
    expect(profile).toContain("<name>Answra 桌面助手</name>");
    expect(profile).toContain("<location>https://github.com/answra/desktop</location>");
    expect(profile).toContain('<change at="2026-11-11T08:00:00.000Z" source="onboarding">');
  });

  it("keeps the wizard pending when the initial profile cannot be created", async () => {
    const { root, store } = await setup();
    await store.addProject({ name: "项目 A" });
    await mkdir(path.join(root, "profile.xml"));

    await expect(store.complete()).rejects.toThrow();
    await expect(store.read()).resolves.toMatchObject({ status: "pending" });

    await rm(path.join(root, "profile.xml"), { recursive: true, force: true });
    await expect(store.complete()).resolves.toMatchObject({ status: "completed" });
    await expect(readFile(path.join(root, "profile.xml"), "utf8")).resolves.toContain(
      '<profile version="1"',
    );
  });

  it("does not overwrite an existing profile document", async () => {
    const { root, store } = await setup();
    const existing = '<profile version="1"><memory>AI 已整理的内容</memory></profile>\n';
    await writeFile(path.join(root, "profile.xml"), existing, "utf8");
    await store.addProject({ name: "项目 A" });

    await store.complete();

    await expect(readFile(path.join(root, "profile.xml"), "utf8")).resolves.toBe(existing);
  });

  it("escapes xml-sensitive characters in the initial profile", async () => {
    const { root, store } = await setup();
    await store.addProject({
      name: "A&B <桌面>",
      location: 'D:\\code\\"x"',
      summary: "a > b",
    });

    await store.complete();

    const profile = await readFile(path.join(root, "profile.xml"), "utf8");
    expect(profile).toContain("<name>A&amp;B &lt;桌面&gt;</name>");
    expect(profile).toContain("<location>D:\\code\\&quot;x&quot;</location>");
    expect(profile).toContain("<summary>a &gt; b</summary>");
  });

  it("completes and skips idempotently without downgrading a completed state", async () => {
    const { store } = await setup();
    await store.addProject({ name: "项目 A" });

    await expect(store.complete()).resolves.toMatchObject({ status: "completed", step: "ready" });
    await expect(store.complete()).resolves.toMatchObject({ status: "completed" });
    await expect(store.skip()).resolves.toMatchObject({ status: "completed" });
  });

  it("reopens a completed or skipped guide from the saved step", async () => {
    const { store } = await setup();
    await store.addProject({ name: "项目 A" });
    await store.update({ step: "ready" });
    await store.complete();

    await expect(store.reopen()).resolves.toMatchObject({ status: "pending", step: "ready" });
    await store.skip();
    await expect(store.reopen()).resolves.toMatchObject({ status: "pending", step: "ready" });
    await expect(store.reopen()).resolves.toMatchObject({ status: "pending" });
  });

  it("starts rehearsal only after the guide is finished", async () => {
    const { store } = await setup();

    await expect(store.startRehearsal()).resolves.toMatchObject({
      status: "pending",
      rehearsalStartedAt: null,
    });

    await store.complete();
    await expect(store.startRehearsal()).resolves.toMatchObject({
      status: "completed",
      rehearsalStartedAt: "2026-11-11T08:00:00.000Z",
    });
    await expect(store.startRehearsal()).resolves.toMatchObject({
      rehearsalStartedAt: "2026-11-11T08:00:00.000Z",
    });
  });

  it("clears the rehearsal stage when the guide is reopened", async () => {
    const { store } = await setup();
    await store.complete();
    await store.startRehearsal();

    await expect(store.reopen()).resolves.toMatchObject({
      status: "pending",
      rehearsalStartedAt: null,
    });
  });

  it("ends the rehearsal without reopening the guide", async () => {
    const { store } = await setup();
    await store.complete();
    await store.startRehearsal();

    await expect(store.endRehearsal()).resolves.toMatchObject({
      status: "completed",
      step: "ready",
      rehearsalStartedAt: null,
    });
    // 已经不在演练阶段时是不写盘的 no-op。
    await expect(store.endRehearsal()).resolves.toMatchObject({ rehearsalStartedAt: null });
    await expect(store.read()).resolves.toMatchObject({ status: "completed" });
  });

  it("falls back to pending when the state file is corrupted", async () => {
    const { root, store } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(path.join(root, "wizard.json"), "{not-json", "utf8");

    await expect(store.read()).resolves.toMatchObject({
      status: "pending",
      step: "resume",
    });
    expect(warn).toHaveBeenCalled();
  });

  it("migrates the legacy onboarding state file to wizard.json", async () => {
    const { root, store } = await setup();
    await writeFile(
      path.join(root, "onboarding.json"),
      JSON.stringify({
        version: 2,
        status: "pending",
        step: "projects",
        resume: null,
        projects: [],
        selectedProjectIds: [],
        targetRole: "前端",
        updatedAt: "2026-11-11T08:00:00.000Z",
      }),
      "utf8",
    );

    await expect(store.read()).resolves.toMatchObject({ step: "projects", targetRole: "前端" });

    const migrated = JSON.parse(await readFile(path.join(root, "wizard.json"), "utf8"));
    expect(migrated).toMatchObject({ step: "projects", targetRole: "前端" });
  });

  it("migrates version 1 state to path-based projects", async () => {
    const { root, store } = await setup();
    await writeFile(
      path.join(root, "wizard.json"),
      JSON.stringify({
        version: 1,
        status: "pending",
        step: "projects",
        resume: {
          id: "resume-1",
          fileName: "旧简历.md",
          projects: [
            { id: "resume-1:project:1", name: "项目 A", summary: "旧摘要", evidence: "原文" },
          ],
        },
        selectedProjectIds: ["resume-1:project:1"],
        targetRole: "前端",
        updatedAt: "2026-11-11T08:00:00.000Z",
      }),
      "utf8",
    );

    const state = await store.read();

    expect(state.version).toBe(2);
    expect(state.resume).toEqual({
      id: "resume-1",
      fileName: "旧简历.md",
      sourcePath: path.join(root, "resumes", "resume-1.txt"),
    });
    expect(state.projects).toEqual([
      { id: "resume-1:project:1", name: "项目 A", summary: "旧摘要" },
    ]);
    expect(state.selectedProjectIds).toEqual(["resume-1:project:1"]);
    expect(state.rehearsalStartedAt).toBeNull();

    const migrated = JSON.parse(await readFile(path.join(root, "wizard.json"), "utf8"));
    expect(migrated).toMatchObject({
      version: 2,
      resume: {
        id: "resume-1",
        fileName: "旧简历.md",
        sourcePath: path.join(root, "resumes", "resume-1.txt"),
      },
      projects: [{ id: "resume-1:project:1", name: "项目 A", summary: "旧摘要" }],
    });
  });
});
