import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";
import COS from "cos-nodejs-sdk-v5";

/**
 * 把 release/ 下的发版产物上传到腾讯云 COS：
 *   download/latest/     覆盖上传（electron-updater 与官网下载按钮固定指向这里）
 *   download/v{version}/ 归档一份，便于回滚
 * 需要 CJS 兼容：cos-nodejs-sdk-v5 是 CJS 包，这里用 default import。
 *
 * 环境变量：
 *   COS_SECRET_ID / COS_SECRET_KEY  腾讯云 API 密钥（必填，除非 --dry-run）
 *   COS_BUCKET                      桶名，默认 answra-1307496114
 *   COS_REGION                      地域，默认 ap-chengdu
 * 用法：node scripts/upload-to-cos.mjs [--dry-run]
 */
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(desktopRoot, "release");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const bucket = process.env.COS_BUCKET ?? "answra-1307496114";
const region = process.env.COS_REGION ?? "ap-chengdu";
const secretId = process.env.COS_SECRET_ID;
const secretKey = process.env.COS_SECRET_KEY;

const { version } = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));

// 以 latest*.yml 清单为准：只上传清单里引用的安装包与差量文件，忽略上次构建遗留的旧产物。
const files = new Set();
for (const name of (await readdir(releaseDir)).filter((n) => /^latest.*\.yml$/i.test(n))) {
  files.add(name);
  const content = await readFile(path.join(releaseDir, name), "utf8");
  for (const match of content.matchAll(/^\s*-?\s*url:\s*(.+)$/gm)) {
    files.add(match[1].trim());
  }
}
if (files.size === 0) {
  console.error(`[upload] ${releaseDir} 下没有 latest*.yml 发版清单，先跑 pnpm dist:win。`);
  process.exit(1);
}

console.log(`[upload] 版本 ${version}，待上传 ${files.size} 个文件：`);
for (const name of files) console.log(`  - ${name}`);

if (dryRun) {
  console.log("[upload] --dry-run：仅列出产物，未实际上传。");
  process.exit(0);
}

if (!secretId || !secretKey) {
  console.error("[upload] 缺少 COS_SECRET_ID / COS_SECRET_KEY 环境变量。");
  process.exit(1);
}

const cos = new COS({ SecretId: secretId, SecretKey: secretKey });
const uploadObject = util.promisify(cos.putObject.bind(cos));

// 先归档版本目录，再覆盖 latest：即使中途失败，latest 也只在版本目录完整后更新。
for (const prefix of [`download/v${version}`, "download/latest"]) {
  for (const name of files) {
    const key = `${prefix}/${name}`;
    await uploadObject({
      Bucket: bucket,
      Region: region,
      Key: key,
      FilePath: path.join(releaseDir, name),
    });
    console.log(`[upload] cos://${bucket}/${key}`);
  }
}
console.log("[upload] 完成：官网与客户端更新源已指向新版本。");
