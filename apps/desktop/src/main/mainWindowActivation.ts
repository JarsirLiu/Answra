/** 主窗口激活：显示已有主窗口或在缺失时重建；不承载窗口策略与主窗口内部绑定。 */
import type { BrowserWindow } from "electron";

/** 主窗口激活端口：只负责“再点一次图标”时显示或重建主窗口，不承载窗口策略。 */
export interface MainWindowActivationHost {
  getWindow: () => BrowserWindow | undefined;
  prepareWindowToShow: (window: BrowserWindow) => boolean;
  createWindow: () => void;
  log?: (message: string, details?: unknown) => void;
}

/**
 * 激活主窗口：存在则显示并聚焦，不存在（已被关闭）则重建。
 * 单实例锁下第二个实例只能走到这里，不能假设主窗口仍然存在。
 */
export function activateMainWindow(host: MainWindowActivationHost): void {
  const window = host.getWindow();
  if (!window || window.isDestroyed()) {
    host.createWindow();
    return;
  }
  if (!window.isVisible()) {
    if (!host.prepareWindowToShow(window)) {
      host.log?.("[window] 主窗口恢复被窗口策略拒绝", { windowId: window.id });
      return;
    }
    window.showInactive();
  }
  window.focus();
}
