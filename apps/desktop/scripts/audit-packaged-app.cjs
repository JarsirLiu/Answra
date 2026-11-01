const { readFile, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { extractFile, listPackage } = require("@electron/asar");

/** Verify the actual Electron app directory after electron-builder has assembled it. */
module.exports = async function auditPackagedApp(context) {
  const manifest = JSON.parse(await readFile("out/release-manifest.json", "utf8"));
  const archivePath = join(context.appOutDir, "resources", "app.asar");
  const archiveEntries = listPackage(archivePath, { isPack: false });
  const normalizedEntries = archiveEntries.map((entry) => entry.replaceAll("\\", "/"));
  const violations = [];

  const packagedManifest = JSON.parse(
    extractFile(archivePath, "out/release-manifest.json").toString("utf8"),
  );
  if (JSON.stringify(packagedManifest) !== JSON.stringify(manifest)) {
    violations.push("app.asar 中的 ReleaseManifest 与构建 Profile 不一致");
  }
  for (const entry of normalizedEntries) {
    if (manifest.profile === "answer" && /(^|\/)node_modules\/sherpa-onnx[^/]*\//i.test(entry)) {
      violations.push(`answer 安装包包含面试原生依赖：${entry}`);
    }
  }

  for (const resource of ["vad", "asr"]) {
    if (manifest.profile === "answer") {
      try {
        await stat(join(context.appOutDir, "resources", resource));
        violations.push(`answer 安装包包含面试模型资源：${resource}`);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
    } else {
      try {
        await stat(join(context.appOutDir, "resources", resource, "manifest.json"));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          violations.push(`full 安装包缺少面试运行资源：${resource}`);
          continue;
        }
        throw error;
      }
    }
  }
  if (manifest.profile === "full") {
    for (const dependency of ["sherpa-onnx-node", "sherpa-onnx-win-x64"]) {
      try {
        await stat(
          join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules", dependency),
        );
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          violations.push(`full 安装包缺少面试原生依赖：${dependency}`);
          continue;
        }
        throw error;
      }
    }
  }

  if (violations.length > 0) throw new Error(`最终安装目录审计失败：\n${violations.join("\n")}`);
  console.log(`✓ ${manifest.profile} 最终 app.asar 与 resources 审计通过`);
};
