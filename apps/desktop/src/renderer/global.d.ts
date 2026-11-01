import type { DesktopBridge } from "@answra/shared";

declare global {
  const __ANSWRA_RELEASE_MANIFEST__: string;
  const __ANSWRA_FEATURE_ANSWER__: boolean;
  const __ANSWRA_FEATURE_CHAT__: boolean;
  const __ANSWRA_FEATURE_WORKSPACE__: boolean;
  const __ANSWRA_FEATURE_INTERVIEW__: boolean;
  const __ANSWRA_FEATURE_SETTINGS__: boolean;
  const __ANSWRA_FEATURE_ACCOUNT__: boolean;
  const __ANSWRA_FEATURE_ANNOUNCEMENTS__: boolean;
  const __ANSWRA_FEATURE_UPDATES__: boolean;
  const __ANSWRA_FEATURE_STEALTH__: boolean;

  interface Window {
    /** preload 注入的桌面平台桥（见 apps/desktop/src/preload/index.ts）。 */
    answra?: DesktopBridge;
  }
}
