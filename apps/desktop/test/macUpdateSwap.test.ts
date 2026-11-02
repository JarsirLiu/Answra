import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMacSwapInstaller,
  extractAppPath,
  macSwapScript,
} from "../src/main/updater/macUpdateSwap";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn };
});

/** 换装脚本与 execPath 反推：等待退出、原子替换、失败还原与重启命令。 */
describe("macUpdateSwap", () => {
  let swapDir: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (swapDir) await rm(swapDir, { recursive: true, force: true });
  });

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

  it("resolves only after the detached swap process emits spawn", async () => {
    swapDir = await mkdtemp(join(tmpdir(), "answra-mac-swap-"));
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawn.mockReturnValue(child);
    const installer = createMacSwapInstaller({
      execPath: "/Applications/Answra.app/Contents/MacOS/Answra",
      swapDir,
      scriptPath: join(swapDir, "swap.sh"),
    });

    let settled = false;
    const started = installer.startInstall("/updates/Answra.app").then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(await readFile(join(swapDir, "swap.sh"), "utf8")).toContain("/updates/Answra.app");
    expect(settled).toBe(false);

    child.emit("spawn");
    await started;
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects if the detached swap process fails to spawn", async () => {
    swapDir = await mkdtemp(join(tmpdir(), "answra-mac-swap-"));
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawn.mockReturnValue(child);
    const installer = createMacSwapInstaller({
      execPath: "/Applications/Answra.app/Contents/MacOS/Answra",
      swapDir,
      scriptPath: join(swapDir, "swap.sh"),
    });

    const started = installer.startInstall("/updates/Answra.app");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emit("error", new Error("spawn failed"));
    await expect(started).rejects.toThrow("spawn failed");
  });
});
