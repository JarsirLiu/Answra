import { describe, expect, it } from "vitest";
import {
  INITIAL_UPDATE_STATE,
  reduceUpdateState,
  type UpdateMachineState,
} from "../src/main/updater/updateState";

/** 更新状态机：事件顺序与失败分流不依赖 electron-updater 也能验。 */
describe("reduceUpdateState", () => {
  it("starts checking from idle and settles to available or up to date", () => {
    const checking = reduceUpdateState(INITIAL_UPDATE_STATE, { type: "check-started" });
    expect(checking.phase).toBe("checking");

    expect(
      reduceUpdateState(checking, { type: "check-finished", availableVersion: "0.2.0" }),
    ).toMatchObject({ phase: "available", availableVersion: "0.2.0" });

    expect(
      reduceUpdateState(checking, { type: "check-finished", availableVersion: null }),
    ).toMatchObject({ phase: "up-to-date", availableVersion: null });
  });

  it("ignores check events while downloading or already downloaded", () => {
    const downloading: UpdateMachineState = {
      phase: "downloading",
      availableVersion: "0.2.0",
      progress: { percent: 40, transferred: 4, total: 10 },
      error: null,
    };
    expect(reduceUpdateState(downloading, { type: "check-started" })).toBe(downloading);

    const downloaded: UpdateMachineState = {
      phase: "downloaded",
      availableVersion: "0.2.0",
      progress: null,
      error: null,
    };
    expect(reduceUpdateState(downloaded, { type: "check-started" })).toBe(downloaded);
  });

  it("turns the first progress event into the downloading phase", () => {
    const available: UpdateMachineState = {
      phase: "available",
      availableVersion: "0.2.0",
      progress: null,
      error: null,
    };
    expect(
      reduceUpdateState(available, {
        type: "download-progress",
        progress: { percent: 12, transferred: 12, total: 100 },
      }),
    ).toMatchObject({ phase: "downloading", progress: { percent: 12 } });
  });

  it("keeps the candidate version when a download fails so retry can resume", () => {
    const downloading: UpdateMachineState = {
      phase: "downloading",
      availableVersion: "0.2.0",
      progress: { percent: 40, transferred: 4, total: 10 },
      error: null,
    };
    expect(reduceUpdateState(downloading, { type: "failed", message: "下载失败" })).toMatchObject({
      phase: "error",
      availableVersion: "0.2.0",
      progress: null,
      error: "下载失败",
    });
  });

  it("returns to idle when an automatic check fails without a user-facing message", () => {
    const checking = reduceUpdateState(INITIAL_UPDATE_STATE, { type: "check-started" });
    expect(reduceUpdateState(checking, { type: "failed", message: null })).toMatchObject({
      phase: "idle",
      error: null,
    });
  });
});
