/** 生成引导完成时的首份 profile.xml；只负责序列化与原子创建，不维护已有画像。 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  INTERVIEW_PROFILE_FILE,
  INTERVIEW_PROFILE_VERSION,
  type InterviewOnboardingProject,
  type InterviewOnboardingState,
} from "@answra/shared";

/**
 * 引导完成时创建首份画像；已存在时不再写入。
 * 画像创建后由 AI 独占维护，引导不会覆盖用户或 AI 后续补充的记忆。
 */
export async function writeInitialProfileDocument(
  dataRoot: string,
  state: InterviewOnboardingState,
): Promise<void> {
  const document = renderProfileDocument(state);
  if (!document) return;
  const profilePath = path.join(dataRoot, INTERVIEW_PROFILE_FILE);
  await mkdir(dataRoot, { recursive: true });
  try {
    await writeFile(profilePath, document, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (isAlreadyExists(error)) {
      const existing = await stat(profilePath).catch(() => undefined);
      if (existing?.isFile()) return;
    }
    throw error;
  }
}

export function renderProfileDocument(state: InterviewOnboardingState): string | null {
  const projects = state.projects.filter((project) =>
    state.selectedProjectIds.includes(project.id),
  );
  const targetRole = state.targetRole.trim();
  if (!targetRole && !state.resume && projects.length === 0) return null;
  const updated = escapeXml(state.updatedAt);
  const lines = [
    `<profile version="${INTERVIEW_PROFILE_VERSION}" updated="${updated}">`,
    `  <target-role>${escapeXml(targetRole)}</target-role>`,
  ];
  if (state.resume) {
    lines.push(
      "  <resume>",
      `    <file>${escapeXml(state.resume.fileName)}</file>`,
      `    <path>${escapeXml(state.resume.sourcePath)}</path>`,
      "  </resume>",
    );
  } else {
    lines.push("  <resume />");
  }
  if (projects.length > 0) {
    lines.push("  <projects>");
    for (const project of projects) lines.push(...renderProject(project));
    lines.push("  </projects>");
  } else {
    lines.push("  <projects />");
  }
  lines.push(
    "  <memory>",
    "  </memory>",
    "  <history>",
    `    <change at="${updated}" source="onboarding">引导完成时创建画像</change>`,
    "  </history>",
    "</profile>",
    "",
  );
  return lines.join("\n");
}

function renderProject(project: InterviewOnboardingProject): string[] {
  const lines = [
    `    <project id="${escapeXml(project.id)}">`,
    `      <name>${escapeXml(project.name)}</name>`,
  ];
  if (project.location) lines.push(`      <location>${escapeXml(project.location)}</location>`);
  if (project.summary) lines.push(`      <summary>${escapeXml(project.summary)}</summary>`);
  lines.push("    </project>");
  return lines;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}
