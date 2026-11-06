import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { resolveReleaseProfile } from "./release-profile.mjs";

const manifest = await resolveReleaseProfile();
const sourceRoots = ["out", "dist"];
const forbiddenExtensions = new Set([".map", ".ts", ".tsx", ".mts", ".cts"]);
const violations = [];

async function visit(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await visit(root, path);
      continue;
    }
    if (forbiddenExtensions.has(extname(entry.name).toLowerCase())) {
      violations.push(`${relative(root, path)}: source or source map is included`);
    }
  }
}

for (const root of sourceRoots) {
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`打包输入目录不是目录：${root}`);
  await visit(root);
}

const builtManifest = JSON.parse(await readFile("out/release-manifest.json", "utf8"));
if (JSON.stringify(builtManifest) !== JSON.stringify(manifest)) {
  violations.push("out/release-manifest.json: selected profile does not match build inputs");
}

const auditDirectory = `.release-audit/${manifest.profile}`;
const featureModulePatterns = {
  chat: [
    "packages/ui/src/components/panels/ChatPanel",
    "agent/src/conversation/turn/chatRuntime.ts",
    "agent/src/conversation/profiles/registry.ts",
  ],
  workspace: [
    "packages/ui/src/components/panels/workspace/",
    "src/main/workspace/composition.ts",
    "src/main/workspace/fileProtocol.ts",
    "src/main/workspace/workspaceIpc.ts",
    "src/main/workspace/workspaceService.ts",
    "agent/src/conversation/tools/registry.ts",
    "agent/src/conversation/tools/read.ts",
    "agent/src/conversation/tools/grep.ts",
    "agent/src/conversation/tools/workspace.ts",
  ],
  interview: [
    "packages/ui/src/components/panels/InterviewCapturePanel",
    "src/main/interview/",
    "src/main/conversation/worker.ts",
    "src/main/conversation/workerTransport.ts",
    "agent/src/interview/audio/",
    "agent/src/interview/turns/",
    "agent/src/interview/vad/",
    "agent/src/interview/transcription/",
  ],
};

function auditEsbuildMetafile(name, contents, expectedEntry) {
  const report = JSON.parse(contents);
  const entries = Object.values(report.outputs)
    .map((output) => output.entryPoint)
    .filter((entryPoint) => typeof entryPoint === "string");
  if (entries.length !== 1 || entries[0] !== expectedEntry) {
    violations.push(`${name}: 入口不符合 ${manifest.profile} Profile：${entries.join(", ")}`);
  }
  const includedInputs = new Set(
    Object.values(report.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, details]) => details.bytesInOutput > 0)
        .map(([input]) => input),
    ),
  );
  for (const input of includedInputs) {
    for (const feature of Object.keys(featureModulePatterns)) {
      if (manifest.features.includes(feature)) continue;
      if (
        featureModulePatterns[feature].some((pattern) =>
          input.replaceAll("\\", "/").includes(pattern),
        )
      ) {
        violations.push(`${name}: excluded ${feature} module is reachable: ${input}`);
      }
    }
  }
}

const expectedEntries = {
  main: "src/main/index.ts",
  preload: manifest.profile === "answer" ? "src/preload/answer.ts" : "src/preload/index.ts",
  "selection-preload": "src/preload/selection.ts",
  "agent-worker": manifest.features.includes("interview")
    ? "src/main/conversation/worker.ts"
    : "src/main/conversation/workerAnswer.ts",
};
for (const name of Object.keys(expectedEntries)) {
  auditEsbuildMetafile(
    `${name}.meta.json`,
    await readFile(`${auditDirectory}/${name}.meta.json`, "utf8"),
    expectedEntries[name],
  );
}

const rendererModules = JSON.parse(
  await readFile(`${auditDirectory}/renderer-modules.json`, "utf8"),
);
for (const input of rendererModules) {
  for (const feature of Object.keys(featureModulePatterns)) {
    if (manifest.features.includes(feature)) continue;
    if (
      featureModulePatterns[feature].some((pattern) =>
        input.replaceAll("\\", "/").includes(pattern),
      )
    ) {
      violations.push(`renderer: excluded ${feature} module is reachable: ${input}`);
    }
  }
}

if (violations.length > 0) throw new Error(`安装包输入审计失败：\n${violations.join("\n")}`);
console.log(`✓ ${manifest.profile} 打包输入审计通过（依赖图、源码与 source map）`);
