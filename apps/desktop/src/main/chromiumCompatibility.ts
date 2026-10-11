import type { App } from "electron";

interface ChromiumCompatibilityOptions {
  app: Pick<App, "commandLine">;
  platform?: NodeJS.Platform;
}

/**
 * 统一 Chromium 的颜色管理配置。sRGB 影响颜色转换，不保证改变
 * desktopCapturer 使用的 DXGI 输出格式；HDR 下的 10-bit 诊断仍可能出现。
 */
export function configureChromiumCompatibility({
  app,
  platform = process.platform,
}: ChromiumCompatibilityOptions): void {
  if (platform !== "win32") return;
  app.commandLine.appendSwitch("force-color-profile", "srgb");
}
