/**
 * 环境变量名常量。
 *
 * 约定：变量名只在此处定义一次；
 * `.env.example` 中逐项说明用途与是否 secret；
 * 运行时一律通过类型化的读取函数访问，禁止散落 `process.env.XXX`。
 */

// ── 编译/打包期可注入 ──────────────────────────────────────────────
/** 应用运行环境。 */
export const ANSWRA_ENV = "ANSWRA_ENV" as const;
export type AnswraEnv = "development" | "production" | "test";

// ── 运行时（主进程启动时读取，后续接入本地 AI 服务时启用） ────────
/** 本地 AI 服务（Agent Runtime）的基础地址。 */
export const AI_SERVICE_BASE_URL = "ANSWRA_AI_BASE_URL" as const;

/** 打开后输出被静默的 IME 焦点/按键诊断日志（低频排查用，默认关闭）。 */
export const ANSWRA_IME_DEBUG = "ANSWRA_IME_DEBUG" as const;

/**
 * 云端网关地址（云端模式的 API 根，如 `https://colorect.cloud`）。
 *
 * 仅开发态可覆盖，且必须是 http 环回地址（见 `apps/desktop/src/main/auth/config.ts`
 * 的 `resolveCloudEndpoints`）；打包版一律使用内置默认值。
 */
export const CLOUD_API_BASE_URL = "ANSWRA_CLOUD_API_BASE_URL" as const;

/** 站点地址（浏览器授权页所在站点）；覆盖规则与 {@link CLOUD_API_BASE_URL} 相同。 */
export const CLOUD_SITE_BASE_URL = "ANSWRA_CLOUD_SITE_BASE_URL" as const;

/** 解析并校验运行环境，非法值回退为 development。 */
export function parseAnswraEnv(value: string | undefined): AnswraEnv {
  return value === "production" || value === "test" ? value : "development";
}

/** 解析 IME 调试开关：仅 `1`/`true` 视为开启。 */
export function parseAnswraImeDebug(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
