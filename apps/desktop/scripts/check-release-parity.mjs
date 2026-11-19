import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EXTRA_TARGETS, FEATURES, featureDefineName, resolveEntry } from "../release-features.mjs";
import { applyReleaseBuilder } from "./electron-builder-config.mjs";
import { resolveReleaseProfile } from "./release-profile.mjs";

/**
 * 发布 Profile 规范化检查（不构建、不启动 Electron）：
 * 1. 共享功能目录与构建期功能表一致；
 * 2. 每个 Profile 都能解析，且入口文件真实存在；
 * 3. `define` / `manifest` 门禁确实在源码中被引用，不存在游离的 define 字面量；
 * 4. 打包配置与功能清单一致（未包含 interview 的版本不得带入 ASR 资源）。
 */
const problems = [];
const notes = [];
const sourceRoots = [
  "src",
  "../../packages/ui/src",
  "../../packages/shared/src",
  "../../apps/agent/src",
];
const skippedDirectories = new Set(["node_modules", "dist", "out", "release"]);
const skippedExtensions = [".d.ts"];

const catalog = JSON.parse(
  await readFile(resolve("../../packages/shared/src/release-features.json"), "utf8"),
);
const tableIds = Object.keys(FEATURES);
if (JSON.stringify(catalog) !== JSON.stringify(tableIds)) {
  problems.push(
    `共享功能目录与 release-features.mjs 不一致：\n  目录 ${catalog.join(",")}\n  构建表 ${tableIds.join(",")}`,
  );
}

async function collectSources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name))
        files.push(...(await collectSources(join(directory, entry.name))));
      continue;
    }
    if (/\.(ts|tsx|mts)$/.test(entry.name)) files.push(join(directory, entry.name));
  }
  return files;
}

const sources = [];
for (const root of sourceRoots) {
  for (const file of await collectSources(resolve(root))) {
    sources.push({ path: file, contents: await readFile(file, "utf8") });
  }
}
const implementationSources = sources.filter(
  ({ path }) => !skippedExtensions.some((suffix) => path.endsWith(suffix)),
);

for (const [feature, definition] of Object.entries(FEATURES)) {
  if (definition.gate === "define") {
    const defineName = featureDefineName(feature);
    const referenced = implementationSources.some(({ contents }) => contents.includes(defineName));
    if (!referenced) problems.push(`功能 ${feature} 声明了编译期门禁，但源码未引用 ${defineName}`);
  }
  if (definition.gate === "manifest") {
    const referenced = implementationSources.some(({ contents }) =>
      contents.includes(`"${feature}"`),
    );
    if (!referenced) problems.push(`功能 ${feature} 依赖发布清单，但源码未读取 "${feature}"`);
  }
  if (definition.gate === "declared") notes.push(feature);
}

const knownDefines = new Set(tableIds.map((feature) => featureDefineName(feature)));
for (const { path, contents } of sources) {
  for (const match of contents.matchAll(/__ANSWRA_FEATURE_[A-Z0-9_]+__/g)) {
    if (!knownDefines.has(match[0])) {
      problems.push(`${path}: 未登记的功能常量 ${match[0]}`);
    }
  }
}

const config = JSON.parse(await readFile("release-profiles.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const profiles = Object.keys(config.profiles ?? {});
if (profiles.length === 0) problems.push("release-profiles.json 未登记任何 Profile");

for (const profile of profiles) {
  let resolved;
  try {
    resolved = await resolveReleaseProfile([`--profile=${profile}`]);
  } catch (error) {
    problems.push(`Profile ${profile} 解析失败：${error.message}`);
    continue;
  }
  const { manifest, builder } = resolved;
  for (const kind of ["agent-worker", "preload"]) {
    const entry = resolveEntry(kind, manifest.features);
    try {
      await readFile(resolve(entry), "utf8");
    } catch {
      problems.push(`Profile ${profile} 的 ${kind} 入口不存在：${entry}`);
    }
  }
  for (const target of EXTRA_TARGETS) {
    if (!manifest.features.includes(target.when)) continue;
    try {
      await readFile(resolve(target.entry), "utf8");
    } catch {
      problems.push(`Profile ${profile} 的 ${target.name} 入口不存在：${target.entry}`);
    }
  }

  const builderConfig = applyReleaseBuilder(structuredClone(packageJson.build), builder);
  if (!manifest.features.includes("interview")) {
    const includedFilePatterns = builderConfig.files.filter((pattern) => !pattern.startsWith("!"));
    const packagedResources = JSON.stringify({
      extraResources: builderConfig.extraResources,
      asarUnpack: builderConfig.asarUnpack,
      files: includedFilePatterns,
    });
    if (/asr|sherpa/i.test(packagedResources)) {
      problems.push(`Profile ${profile} 未包含 interview，但打包配置仍带入语音/ASR 资源`);
    }
  }
}

if (problems.length > 0) {
  throw new Error(`发布 Profile 规范化检查失败：\n- ${problems.join("\n- ")}`);
}
if (notes.length > 0) {
  console.warn(`提示：以下功能已在清单登记但尚未接运行时门禁：${notes.join(", ")}`);
}
console.log(
  `✓ 发布 Profile 规范化检查通过（${profiles.length} 个 Profile，${tableIds.length} 项功能）`,
);
