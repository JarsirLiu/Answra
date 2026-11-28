/**
 * 所有从 bridge/IPC 抛上来的失败都在这里收敛：失败码与统一文案决定语义，
 * Electron 的 IPC 外壳只剥掉、不吞掉内层事实。渲染层不猜自然语言。
 */
import {
  AUTH_REQUIRED_NOTICE,
  isAuthRequiredError,
  isModelRequiredError,
  MODEL_REQUIRED_NOTICE,
} from "@answra/shared";

const IPC_ERROR_PREFIX = /^Error invoking remote method [^:]+:\s*(?:Error:\s*)?/u;

export interface UserFacingModelFailure {
  message: string;
  /** 云端来源缺登录态：给出「去登录」。 */
  needsSignIn: boolean;
  /** 本地来源缺端点：给出「配置本地模型」。 */
  needsModelSetup: boolean;
}

export function toUserFacingFailure(error: unknown, fallback: string): UserFacingModelFailure {
  if (isAuthRequiredError(error))
    return { message: AUTH_REQUIRED_NOTICE, needsSignIn: true, needsModelSetup: false };
  if (isModelRequiredError(error))
    return { message: MODEL_REQUIRED_NOTICE, needsSignIn: false, needsModelSetup: true };
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const message = raw.replace(IPC_ERROR_PREFIX, "").trim();
  return {
    message: message === "" ? fallback : message,
    needsSignIn: false,
    needsModelSetup: false,
  };
}
