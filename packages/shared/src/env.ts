/**
 * 环境变量名常量。
 *
 * 约定（与 ZCode 一致）：变量名只在此处定义一次；
 * `.env.example` 中逐项说明用途与是否 secret；
 * 运行时一律通过类型化的读取函数访问，禁止散落 `process.env.XXX`。
 */

// ── 编译/打包期可注入 ──────────────────────────────────────────────
/** 应用运行环境。 */
export const EXAM_ASSISTANT_ENV = "EXAM_ASSISTANT_ENV" as const;
export type ExamAssistantEnv = "development" | "production" | "test";

// ── 运行时（主进程启动时读取，后续接入本地 AI 服务时启用） ────────
/** 本地 AI 服务（Agent Runtime）的基础地址。 */
export const AI_SERVICE_BASE_URL = "EXAM_ASSISTANT_AI_BASE_URL" as const;

/** 解析并校验运行环境，非法值回退为 development。 */
export function parseExamAssistantEnv(value: string | undefined): ExamAssistantEnv {
  return value === "production" || value === "test" ? value : "development";
}
