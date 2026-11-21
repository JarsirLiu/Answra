import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FEATURE_IDS } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { applyReleaseBuilder } from "../scripts/electron-builder-config.mjs";
import { resolveReleaseProfile } from "../scripts/release-profile.mjs";
import { readViteReleaseConfig } from "../scripts/vite-release-config";

async function readProfiles() {
  const contents = await readFile(resolve("release-profiles.json"), "utf8");
  return JSON.parse(contents) as {
    schemaVersion: number;
    profiles: Record<
      string,
      {
        include: string[];
        exclude: string[];
        builder?: Record<string, unknown>;
      }
    >;
  };
}

describe("release profile resolution", () => {
  it("uses the explicit answer allowlist and keeps the notebook workspace", async () => {
    const { manifest } = await resolveReleaseProfile(["--profile=answer"]);
    expect(manifest.profile).toBe("answer");
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.features).toContain("answer");
    expect(manifest.features).toContain("workspace");
    expect(manifest.features).toContain("local-model");
    expect(manifest.features).not.toContain("chat");
    expect(manifest.features).not.toContain("interview");
  });

  it("keeps local models out of the internal full profile", async () => {
    const { manifest } = await resolveReleaseProfile(["--profile=full"]);
    expect(manifest.features).toContain("interview");
    expect(manifest.features).not.toContain("local-model");
  });

  it("keeps the manifest feature order deterministic", async () => {
    const { manifest } = await resolveReleaseProfile(["--profile=answer"]);
    const ordered = FEATURE_IDS.filter((feature) => manifest.features.includes(feature));
    expect(manifest.features).toEqual(ordered);
  });

  it("rejects absent, repeated, unknown, and malformed profile selections", async () => {
    await expect(resolveReleaseProfile([])).rejects.toThrow("必须且只能指定一个");
    await expect(resolveReleaseProfile(["--profile=answer", "--profile=full"])).rejects.toThrow(
      "必须且只能指定一个",
    );
    await expect(resolveReleaseProfile(["--profile=internal"])).rejects.toThrow("未知发布 Profile");
    await expect(resolveReleaseProfile(["--profile=Answer"])).rejects.toThrow("名称非法");
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
    const config = await readProfiles();
    expect(config.schemaVersion).toBe(2);
    expect(Object.keys(config.profiles).length).toBeGreaterThan(0);
    for (const [profile, decision] of Object.entries(config.profiles)) {
      expect([...decision.include, ...decision.exclude].sort()).toEqual([...FEATURE_IDS].sort());
      expect(decision.include).toContain("answer");
      const { manifest } = await resolveReleaseProfile([`--profile=${profile}`]);
      expect(manifest.profile).toBe(profile);
    }
    await expect(readViteReleaseConfig()).resolves.toEqual(config.profiles);
  });

  it("applies the profile builder block over the packaged configuration", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const { builder } = await resolveReleaseProfile(["--profile=answer"]);
    const config = applyReleaseBuilder(structuredClone(packageJson.build), builder);
    expect(config.extraResources).toEqual([]);
    expect(config.asarUnpack).toEqual([
      "**/node_modules/@napi-rs/keyring*/**",
      "**/node_modules/node-datachannel/**",
      "**/node_modules/@node-datachannel/**",
    ]);
    expect(config.files).toContain("!**/node_modules/sherpa-onnx-node/**");
    expect(config.appId).toBe("dev.answra.desktop");
  });
});
