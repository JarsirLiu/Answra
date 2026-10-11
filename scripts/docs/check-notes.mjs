import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIFECYCLES = new Set(["proposed", "implemented", "rejected", "archived"]);
const CATEGORIES = new Set([
  "architecture",
  "bug-fix",
  "feature",
  "process",
  "simplification",
  "testing",
]);
const REQUIRED = {
  proposed: ["问题", "涉及范围", "提案", "曾考虑的替代方案", "验收标准", "风险"],
  implemented: ["问题", "涉及范围", "决定", "曾考虑的替代方案", "后果与防回退", "验证"],
  rejected: ["问题", "涉及范围", "提案", "曾考虑的替代方案", "否决理由", "后果与防回退"],
  archived: ["问题", "涉及范围", "决定", "曾考虑的替代方案", "后果与防回退", "验证"],
};
const CATEGORY_REQUIRED = {
  architecture: ["模块边界"],
  "bug-fix": ["根因", "修复"],
  feature: ["影响表面"],
  process: ["流程变化"],
  simplification: ["移除内容", "重新引入条件"],
  testing: ["测试范围"],
};
const errors = [];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function changedFiles() {
  const baseIndex = process.argv.indexOf("--base");
  if (baseIndex >= 0) {
    const base = process.argv[baseIndex + 1];
    if (!base) throw new Error("--base 后必须提供目标分支或提交 SHA");
    return new Set(
      git(["diff", "--name-only", "--diff-filter=ACDMRT", `${base}...HEAD`])
        .split(/\r?\n/)
        .filter(Boolean),
    );
  }

  const changed = new Set(
    git(["diff", "--name-only", "--diff-filter=ACDMRT", "HEAD"]).split(/\r?\n/).filter(Boolean),
  );
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  for (const file of untracked.split(/\r?\n/).filter(Boolean)) changed.add(file);
  return changed;
}

function markdownFiles(dir) {
  if (!statSync(dir).isDirectory()) return [];
  const result = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) result.push(...markdownFiles(fullPath));
    else if (entry.toLowerCase().endsWith(".md")) result.push(fullPath);
  }
  return result;
}

function checkNote(filePath) {
  const relative = path.relative(ROOT, filePath).replaceAll("\\", "/");
  const parts = relative.split("/");
  if (parts.length !== 5 || parts[0] !== "docs" || parts[1] !== "notes") {
    errors.push(`${relative}: Note 必须直接放在 docs/notes/<生命周期>/<类别>/ 下`);
    return;
  }

  const [, , lifecycle, category, filename] = parts;
  if (!LIFECYCLES.has(lifecycle)) errors.push(`${relative}: 未知生命周期 ${lifecycle}`);
  if (!CATEGORIES.has(category)) errors.push(`${relative}: 未知类别 ${category}`);
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(filename)) {
    errors.push(`${relative}: 文件名须为 YYYY-MM-DD-kebab-case.md`);
  }

  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  if (!/^# Note[：:]/.test(lines[0] ?? "")) errors.push(`${relative}: 第一行须为中文 Note 标题`);

  const expectedStatus = {
    proposed: /^状态：提案\s*$/,
    implemented: /^状态：已实施\s*$/,
    rejected: /^状态：已拒绝：.+$/,
    archived: /^状态：已实施\s*$/,
  }[lifecycle];
  if (!expectedStatus?.test(lines[2] ?? "")) {
    errors.push(`${relative}: 状态行与 ${lifecycle} 生命周期不匹配`);
  }
  if (lifecycle === "archived" && !/^归档日期：\d{4}-\d{2}-\d{2}$/.test(lines[3] ?? "")) {
    errors.push(`${relative}: 归档 Note 第四行必须记录归档日期`);
  }

  const headings = new Set(
    [...content.matchAll(/^##\s+(.+)\s*$/gm)].map((match) => match[1].trim()),
  );
  for (const heading of REQUIRED[lifecycle] ?? []) {
    if (!headings.has(heading)) errors.push(`${relative}: 缺少必需章节“${heading}”`);
  }
  for (const heading of CATEGORY_REQUIRED[category] ?? []) {
    if (!headings.has(heading))
      errors.push(`${relative}: ${category} Note 缺少类别章节“${heading}”`);
  }

  const alternativeSection =
    content.match(/^## 曾考虑的替代方案\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? "";
  const alternatives = [...alternativeSection.matchAll(/^\s*-\s+\*\*.+?\*\*/gm)];
  if (alternatives.length < 2) {
    errors.push(`${relative}: 至少记录两个真实替代方案，并说明采用或舍弃的原因`);
  }

  const body = content.replace(/^#.*\n(?:\r?\n)?状态：.*\n/, "");
  if (body.trim().length < 300)
    errors.push(`${relative}: Note 内容过短，须留下可复用的背景、取舍与经验`);
  checkMarkdownLinks(filePath, content);
}

function checkMarkdownLinks(filePath, source = readFileSync(filePath, "utf8")) {
  const relative = path.relative(ROOT, filePath).replaceAll("\\", "/");
  const prose = source.replace(/```[\s\S]*?```/g, "");
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    const destination = raw.startsWith("<")
      ? raw.slice(1, raw.indexOf(">"))
      : raw.split(/\s+/, 1)[0];
    if (!destination || /^(?:[a-z]+:|\/\/|#)/i.test(destination)) continue;
    let target;
    try {
      target = decodeURIComponent(destination.split("#", 1)[0]);
    } catch {
      errors.push(`${relative}: 链接地址编码错误: ${destination}`);
      continue;
    }
    if (!target) continue;
    try {
      statSync(path.resolve(path.dirname(filePath), target));
    } catch {
      errors.push(`${relative}: 本地链接目标不存在: ${destination}`);
    }
  }
}

function requiresNote(file) {
  const normalized = file.replaceAll("\\", "/");
  return !normalized.startsWith("docs/notes/");
}

try {
  const changed = changedFiles();
  const noteChanges = [...changed].filter(
    (file) => file.replaceAll("\\", "/").startsWith("docs/notes/") && file.endsWith(".md"),
  );
  const otherChanges = [...changed].filter(requiresNote);
  if (otherChanges.length && noteChanges.length === 0) {
    errors.push(
      `本次变更涉及工程文件但没有新增/更新 Note：\n${otherChanges.map((file) => `  - ${file}`).join("\n")}`,
    );
  }

  const docsRoot = path.join(ROOT, "docs");
  const strayDocs = readdirSync(docsRoot, { withFileTypes: true }).filter(
    (entry) =>
      entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name !== "README.md",
  );
  for (const entry of strayDocs)
    errors.push(`docs/${entry.name}: 专题文档必须迁入 docs/notes/ 生命周期目录`);
  for (const legacy of ["specs", "decisions"]) {
    try {
      const legacyPath = path.join(docsRoot, legacy);
      const entries = markdownFiles(legacyPath);
      if (entries.length > 0) {
        errors.push(`docs/${legacy}/: 平铺文档目录已废弃，内容必须迁入 docs/notes/`);
      }
    } catch {}
  }

  for (const filePath of markdownFiles(path.join(docsRoot, "notes"))) {
    if (
      path
        .relative(path.join(docsRoot, "notes"), filePath)
        .replaceAll("\\", "/")
        .startsWith("templates/")
    ) {
      checkMarkdownLinks(filePath);
    } else {
      checkNote(filePath);
    }
  }
  checkMarkdownLinks(path.join(docsRoot, "README.md"));

  if (errors.length) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ Note 检查通过（${noteChanges.length} 份本次 Note，${changed.size} 个变更文件）`);
  }
} catch (error) {
  console.error(`✗ Note 检查无法完成：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
