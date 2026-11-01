/**
 * 更新状态机：把 electron-updater 事件归约成可展示的 phase / 版本 / 进度。
 *
 * 这里只做纯状态转换，不读写文件、不启动进程；IO 与 electron-updater 的接线留在
 * updateController。这样并发的检查、下载与失败分支可以用普通单测压住。
 */

import type { UpdatePhase, UpdateProgress } from "@answra/shared";

export interface UpdateMachineState {
  phase: UpdatePhase;
  availableVersion: string | null;
  progress: UpdateProgress | null;
  error: string | null;
}

export type UpdateMachineEvent =
  | { type: "check-started" }
  | { type: "check-finished"; availableVersion: string | null }
  | { type: "download-started" }
  | { type: "download-progress"; progress: UpdateProgress }
  | { type: "downloaded"; version: string }
  | { type: "failed"; message: string | null };

export const INITIAL_UPDATE_STATE: UpdateMachineState = {
  phase: "idle",
  availableVersion: null,
  progress: null,
  error: null,
};

export function reduceUpdateState(
  state: UpdateMachineState,
  event: UpdateMachineEvent,
): UpdateMachineState {
  switch (event.type) {
    case "check-started":
      if (
        state.phase === "checking" ||
        state.phase === "downloading" ||
        state.phase === "downloaded" ||
        state.phase === "unsupported"
      ) {
        return state;
      }
      return { ...state, phase: "checking", progress: null, error: null };

    case "check-finished":
      if (state.phase !== "checking") return state;
      return {
        ...state,
        phase: event.availableVersion ? "available" : "up-to-date",
        availableVersion: event.availableVersion,
        progress: null,
        error: null,
      };

    case "download-started":
      if (state.phase !== "available" && state.phase !== "error") return state;
      return {
        ...state,
        phase: "downloading",
        progress: { percent: 0, transferred: 0, total: 0 },
        error: null,
      };

    case "download-progress":
      if (state.phase !== "downloading" && state.phase !== "available") return state;
      return { ...state, phase: "downloading", progress: event.progress };

    case "downloaded":
      if (state.phase === "unsupported") return state;
      return {
        ...state,
        phase: "downloaded",
        availableVersion: event.version,
        progress: null,
        error: null,
      };

    case "failed":
      if (
        state.phase !== "checking" &&
        state.phase !== "available" &&
        state.phase !== "downloading"
      ) {
        return state;
      }
      return {
        ...state,
        phase: event.message ? "error" : "idle",
        progress: null,
        error: event.message,
      };
  }
}
