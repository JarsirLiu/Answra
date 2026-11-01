import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingUpdate,
  isNewerVersion,
  pendingUpdateMarkerPath,
  readPendingUpdate,
  writePendingUpdate,
} from "../src/main/updater/pendingUpdate";

/** 待安装更新记录：持久化格式与版本比较。 */
describe("pendingUpdate", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "answra-pending-update-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("round-trips a pending update record", () => {
    const markerPath = pendingUpdateMarkerPath(configDir);
    writePendingUpdate(markerPath, {
      version: "0.2.0",
      installerPath: join(configDir, "Answra-Setup.exe"),
    });
    expect(readPendingUpdate(markerPath)).toEqual({
      version: "0.2.0",
      installerPath: join(configDir, "Answra-Setup.exe"),
    });
  });

  it("treats a missing marker as no pending update", () => {
    expect(readPendingUpdate(pendingUpdateMarkerPath(configDir))).toBeNull();
  });

  it("rejects malformed or incomplete records", () => {
    const markerPath = pendingUpdateMarkerPath(configDir);
    writePendingUpdate(markerPath, { version: "0.2.0" } as never);
    expect(readPendingUpdate(markerPath)).toBeNull();
  });

  it("clears the marker idempotently", () => {
    const markerPath = pendingUpdateMarkerPath(configDir);
    writePendingUpdate(markerPath, { version: "0.2.0", installerPath: "C:\\tmp\\a.exe" });
    clearPendingUpdate(markerPath);
    clearPendingUpdate(markerPath);
    expect(readPendingUpdate(markerPath)).toBeNull();
  });

  it("compares versions numerically", () => {
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerVersion("1.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
  });

  it("does not apply versions it cannot parse", () => {
    expect(isNewerVersion("latest", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "")).toBe(false);
  });
});
