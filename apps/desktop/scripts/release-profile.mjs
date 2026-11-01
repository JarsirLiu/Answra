import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const profileIds = new Set(["answer", "full"]);

/** Resolve one explicitly selected release profile; malformed input never falls back. */
export async function resolveReleaseProfile(args = process.argv.slice(2)) {
  const supplied = args.filter((argument) => argument.startsWith("--profile="));
  if (supplied.length !== 1) {
    throw new Error("必须且只能指定一个 --profile=answer|full");
  }
  const profile = supplied[0].slice("--profile=".length);
  if (!profileIds.has(profile)) throw new Error(`未知发布 Profile：${profile || "(空)"}`);

  const configPath = resolve("release-profiles.json");
  const profiles = JSON.parse(await readFile(configPath, "utf8"));
  if (typeof profiles !== "object" || profiles === null) {
    throw new Error("发布 Profile 配置格式无效");
  }
  if (
    Object.keys(profiles).length !== profileIds.size ||
    Object.keys(profiles).some((configuredProfile) => !profileIds.has(configuredProfile))
  ) {
    throw new Error("发布 Profile 配置必须与封闭的 ReleaseProfile 联合保持一致");
  }
  const decision = profiles[profile];
  if (
    typeof decision !== "object" ||
    decision === null ||
    !Array.isArray(decision.include) ||
    !Array.isArray(decision.exclude)
  ) {
    throw new Error(`发布 Profile 缺少显式功能清单：${profile}`);
  }
  const featuresPath = resolve("../../packages/shared/src/release-features.json");
  const featureIds = JSON.parse(await readFile(featuresPath, "utf8"));
  if (!Array.isArray(featureIds) || featureIds.length === 0) {
    throw new Error("共享功能目录无效或为空");
  }
  const features = decision.include;
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
  if (features.length === 0) throw new Error(`发布 Profile 功能清单不能为空：${profile}`);
  if (!seen.has("answer")) throw new Error(`发布 Profile 必须包含 answer：${profile}`);
  return { schemaVersion: 1, profile, features };
}
