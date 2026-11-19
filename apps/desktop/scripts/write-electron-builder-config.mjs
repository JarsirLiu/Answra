import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyCliPackaging } from "./cli-packaging.mjs";
import { applyReleaseBuilder } from "./electron-builder-config.mjs";
import { resolveReleaseProfile } from "./release-profile.mjs";

const { manifest, builder } = await resolveReleaseProfile();
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const config = applyReleaseBuilder(structuredClone(packageJson.build), builder);
config.afterPack = resolve("scripts/after-pack.cjs");

applyCliPackaging(config);

const outputPath = `.release-audit/${manifest.profile}/electron-builder.json`;
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`✓ 已生成 ${manifest.profile} electron-builder 配置：${outputPath}`);
