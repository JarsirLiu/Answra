import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FeatureId } from "@answra/shared";

export interface ProfileDecision {
  include: FeatureId[];
  exclude: FeatureId[];
}
export type ProfileDecisions = Record<string, ProfileDecision>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecision(value: unknown, featureIds: readonly string[]): value is ProfileDecision {
  if (!isPlainObject(value)) return false;
  const { include, exclude } = value;
  if (!Array.isArray(include) || !Array.isArray(exclude)) return false;
  const decisions = [...include, ...exclude];
  return (
    decisions.every((feature) => typeof feature === "string" && featureIds.includes(feature)) &&
    decisions.length === featureIds.length &&
    decisions.length === new Set(decisions).size &&
    featureIds.every((feature) => decisions.includes(feature)) &&
    include.length > 0 &&
    include.includes("answer")
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

/** Read and validate the renderer profile contract outside the Vite config boundary. */
export async function readViteReleaseConfig(): Promise<ProfileDecisions> {
  const featureIds = await readJson("../../packages/shared/src/release-features.json");
  if (
    !Array.isArray(featureIds) ||
    featureIds.length === 0 ||
    !featureIds.every((feature) => typeof feature === "string")
  ) {
    throw new Error("共享功能目录无效或为空");
  }
  const config = await readJson("release-profiles.json");
  if (!isPlainObject(config) || config.schemaVersion !== 2 || !isPlainObject(config.profiles)) {
    throw new Error("发布 Profile 配置必须是 schemaVersion=2 的 profiles 对象");
  }
  const profiles = config.profiles;
  const decisions = Object.values(profiles);
  if (decisions.length === 0 || !decisions.every((decision) => isDecision(decision, featureIds))) {
    throw new Error("发布 Profile 必须为目录中每项功能明确选择包含或排除");
  }
  return profiles as ProfileDecisions;
}
