import type { DesktopBridge } from "@exam-assistant/shared";

declare global {
  interface Window {
    /** preload 注入的桌面平台桥（见 apps/desktop/src/preload/index.ts）。 */
    examAssistant?: DesktopBridge;
  }
}
