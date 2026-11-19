import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const BUILDER_KEYS = new Set([
  "appId",
  "productName",
  "output",
  "nsisArtifactName",
  "extraResources",
  "extraResourcesAppend",
  "asarUnpack",
  "filesExclude",
]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringArray(value, label, profile) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Profile ${profile} 的 ${label} 必须是字符串数组`);
  }
}

/** 校验可选的 builder 覆盖块；未知键直接拒绝，避免拼写错误静默失效。 */
function validateBuilder(builder, profile) {
  if (builder === undefined) return {};
  if (!isPlainObject(builder)) throw new Error(`Profile ${profile} 的 builder 必须是对象`);
  for (const key of Object.keys(builder)) {
    if (!BUILDER_KEYS.has(key)) throw new Error(`Profile ${profile} 的 builder 含未知键：${key}`);
  }
  for (const key of ["appId", "productName", "output", "nsisArtifactName"]) {
    if (key in builder && typeof builder[key] !== "string") {
      throw new Error(`Profile ${profile} 的 builder.${key} 必须是字符串`);
    }
  }
  for (const key of ["asarUnpack", "filesExclude"]) {
    if (key in builder) assertStringArray(builder[key], `builder.${key}`, profile);
  }
  for (const key of ["extraResources", "extraResourcesAppend"]) {
    if (key in builder && !Array.isArray(builder[key])) {
      throw new Error(`Profile ${profile} 的 builder.${key} 必须是数组`);
    }
  }
  return builder;
}

/**
 * 解析一个显式选择的发布 Profile；非法输入直接失败，绝不回退。
 *
 * Profile 集合完全由 `release-profiles.json` 的 `profiles` 键决定：
 * 新增发行版本（例如技术版）只需改配置，不改构建脚本。
 */
export async function resolveReleaseProfile(args = process.argv.slice(2)) {
  const supplied = args.filter((argument) => argument.startsWith("--profile="));
  if (supplied.length !== 1) {
    throw new Error("必须且只能指定一个 --profile=<已登记的 Profile>");
  }
  const profile = supplied[0].slice("--profile=".length);
  if (!PROFILE_ID_PATTERN.test(profile)) {
    throw new Error(`发布 Profile 名称非法：${profile || "(空)"}`);
  }

  const config = JSON.parse(await readFile(resolve("release-profiles.json"), "utf8"));
  if (!isPlainObject(config) || config.schemaVersion !== 2 || !isPlainObject(config.profiles)) {
    throw new Error("发布 Profile 配置必须是 schemaVersion=2 的 profiles 对象");
  }
  const decisions = config.profiles;
  if (Object.keys(decisions).length === 0) throw new Error("发布 Profile 配置不能为空");
  for (const id of Object.keys(decisions)) {
    if (!PROFILE_ID_PATTERN.test(id)) throw new Error(`发布 Profile 名称非法：${id}`);
  }
  const decision = decisions[profile];
  if (decision === undefined) throw new Error(`未知发布 Profile：${profile || "(空)"}`);

  const featureIds = JSON.parse(
    await readFile(resolve("../../packages/shared/src/release-features.json"), "utf8"),
  );
  if (!Array.isArray(featureIds) || featureIds.length === 0) {
    throw new Error("共享功能目录无效或为空");
  }
  if (
    !isPlainObject(decision) ||
    !Array.isArray(decision.include) ||
    !Array.isArray(decision.exclude)
  ) {
    throw new Error(`发布 Profile 缺少显式功能清单：${profile}`);
  }
  const seen = new Set();
  for (const feature of [...decision.include, ...decision.exclude]) {
    if (typeof feature !== "string" || !featureIds.includes(feature)) {
      throw new Error(`未知功能 ID：${String(feature)}`);
    }
    if (seen.has(feature)) throw new Error(`功能 ID 重复：${feature}`);
    seen.add(feature);
  }
  if (seen.size !== featureIds.length || featureIds.some((feature) => !seen.has(feature))) {
    throw new Error(`Profile ${profile} 必须为目录中每项功能明确选择包含或排除`);
  }
  if (decision.include.length === 0) throw new Error(`发布 Profile 功能清单不能为空：${profile}`);
  if (!decision.include.includes("answer")) {
    throw new Error(`发布 Profile 必须包含 answer 核心能力：${profile}`);
  }

  return {
    manifest: {
      schemaVersion: 2,
      profile,
      features: featureIds.filter((feature) => decision.include.includes(feature)),
    },
    builder: validateBuilder(decision.builder, profile),
  };
}
