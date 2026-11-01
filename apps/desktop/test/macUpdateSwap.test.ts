import { describe, expect, it } from "vitest";
import { extractAppPath, macSwapScript } from "../src/main/updater/macUpdateSwap";

/** 换装脚本与 execPath 反推：等待退出、原子替换、失败还原与重启命令。 */
describe("macUpdateSwap", () => {
  it("derives the running app bundle from the executable path", () => {
    expect(extractAppPath("/Applications/Answra.app/Contents/MacOS/Answra")).toBe(
      "/Applications/Answra.app",
    );
    expect(extractAppPath("/usr/local/bin/answra")).toBeNull();
  });

  it("waits for the old process, swaps atomically, restores on failure and relaunches", () => {
    const script = macSwapScript("/Applications/Answra.app", "/updates/Answra.app");

    expect(script).toContain('RUNNING_MARK="/Applications/Answra.app/Contents/MacOS/"');
    expect(script).toContain('APP="/Applications/Answra.app"');
    expect(script).toContain('NEW="/updates/Answra.app"');
    expect(script).toContain('OLD="/Applications/Answra.app.old"');
    expect(script).toContain('pgrep -f "$RUNNING_MARK" >/dev/null || break');
    expect(script).toContain('if ! mv "$APP" "$OLD" || ! mv "$NEW" "$APP"; then');
    expect(script).toContain('mv "$OLD" "$APP" 2>/dev/null || true');
    expect(script).toContain('open "$APP"');
  });
});
