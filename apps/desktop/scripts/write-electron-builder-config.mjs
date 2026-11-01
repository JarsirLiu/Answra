import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveReleaseProfile } from "./release-profile.mjs";

const manifest = await resolveReleaseProfile();
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const config = structuredClone(packageJson.build);
config.afterPack = resolve("scripts/after-pack.cjs");

if (manifest.profile === "answer") {
  config.extraResources = [];
  config.asarUnpack = [];
  config.files.push("!**/node_modules/sherpa-onnx-node/**", "!**/node_modules/sherpa-onnx-*/**");
} else {
  config.appId = "dev.answra.desktop.internal";
  config.productName = "Answra Internal";
  config.directories.output = "release/full";
  const artifactVariables = ["$", "{arch}", ".", "$", "{ext}"].join("");
  config.nsis.artifactName = `Answra-Internal-Setup-${artifactVariables}`;
  config.extraResources = [
    ...config.extraResources,
    { from: "resources/asr", to: "asr", filter: ["**/*"] },
  ];
}

const outputPath = `.release-audit/${manifest.profile}/electron-builder.json`;
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`✓ 已生成 ${manifest.profile} electron-builder 配置：${outputPath}`);
