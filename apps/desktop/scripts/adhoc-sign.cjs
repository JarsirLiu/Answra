const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const entitlementsPath = join(__dirname, "..", "build", "entitlements.mac.plist");

/**
 * Unsigned macOS builds still need an ad-hoc signature: Apple Silicon refuses to
 * launch an unsigned bundle, and Electron's V8 JIT needs the allow-jit
 * entitlement. Signing with `--sign -` is not a distributable identity, so a real
 * CSC_LINK/CSC_NAME takes precedence and this hook steps aside.
 */
module.exports = async function adHocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync(
    "codesign",
    ["--force", "--deep", "--entitlements", entitlementsPath, "--sign", "-", appPath],
    { stdio: "inherit" },
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  console.log(`✓ macOS ad-hoc 签名并校验通过：${appPath}`);
};
