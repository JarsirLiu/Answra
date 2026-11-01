import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FEATURE_IDS, RELEASE_PROFILES } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { resolveReleaseProfile } from "../scripts/release-profile.mjs";
import { readViteReleaseConfig } from "../scripts/vite-release-config";

describe("release profile resolution", () => {
  it("uses the explicit answer allowlist and excludes internal feature domains", async () => {
    const manifest = await resolveReleaseProfile(["--profile=answer"]);
    expect(manifest.profile).toBe("answer");
    expect(manifest.features).toContain("answer");
    expect(manifest.features).not.toContain("chat");
    expect(manifest.features).not.toContain("workspace");
    expect(manifest.features).not.toContain("interview");
  });

  it("rejects absent, repeated, and unknown profile selections", async () => {
    await expect(resolveReleaseProfile([])).rejects.toThrow("必须且只能指定一个");
    await expect(resolveReleaseProfile(["--profile=answer", "--profile=full"])).rejects.toThrow(
      "必须且只能指定一个",
    );
    await expect(resolveReleaseProfile(["--profile=internal"])).rejects.toThrow("未知发布 Profile");
  });

  it("rejects arguments that resemble a profile but are not the exact option", async () => {
    await expect(resolveReleaseProfile(["--profile", "answer"])).rejects.toThrow(
      "必须且只能指定一个",
    );
  });

  it("keeps the build-time feature catalog aligned with the TypeScript contract", async () => {
    const featurePath = resolve("../../packages/shared/src/release-features.json");
    const featureIds = JSON.parse(await readFile(featurePath, "utf8"));
    expect(featureIds).toEqual([...FEATURE_IDS]);
  });

  it("requires every profile to explicitly include or exclude every shared feature ID", async () => {
    const profilePath = resolve("release-profiles.json");
    const profiles = JSON.parse(await readFile(profilePath, "utf8"));
    expect(Object.keys(profiles).sort()).toEqual([...RELEASE_PROFILES].sort());
    for (const profile of Object.values(profiles) as Array<{
      include: string[];
      exclude: string[];
    }>) {
      expect([...profile.include, ...profile.exclude].sort()).toEqual([...FEATURE_IDS].sort());
    }
    await expect(readViteReleaseConfig()).resolves.toEqual(profiles);
  });
});
