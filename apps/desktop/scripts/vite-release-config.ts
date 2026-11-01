import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FeatureId, ReleaseProfile } from "@answra/shared";

type ProfileDecision = { include: FeatureId[]; exclude: FeatureId[] };
export type ProfileDecisions = Record<ReleaseProfile, ProfileDecision>;

function isDecision(value: unknown, featureIds: readonly string[]): value is ProfileDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { include, exclude } = value as Record<string, unknown>;
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
  const profiles = await readJson("release-profiles.json");
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) {
    throw new Error("Vite Profile 配置必须与 ReleaseProfile 联合保持一致");
  }
  const decisions = Object.values(profiles);
  if (decisions.length === 0 || !decisions.every((decision) => isDecision(decision, featureIds))) {
    throw new Error("Vite Profile 配置必须与 ReleaseProfile 联合保持一致");
  }
  return profiles as ProfileDecisions;
}
