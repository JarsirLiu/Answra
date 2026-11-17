/** TUI 命令与面板动作的运行中可用性策略：唯一判定与提示文案；不依赖 store、会话或 Ink。 */

export type TuiAccessScope = "active" | "all";

export type TuiAccess =
  | { readonly whileRunning: "allow" }
  | { readonly whileRunning: "deny"; readonly action: string; readonly scope: TuiAccessScope };

export interface TuiRuntime {
  /** 任一会话是否运行；全局命令（模型配置、退出等）使用。 */
  readonly runActive: boolean;
  /** 当前会话是否运行；会话内命令使用。 */
  readonly activeRunActive?: boolean;
  readonly compactionActive: boolean;
}

export const ALWAYS_AVAILABLE: TuiAccess = { whileRunning: "allow" };

export function idleOnly(action: string, scope: TuiAccessScope = "all"): TuiAccess {
  return { whileRunning: "deny", action, scope };
}

/** 面板内动作的 access；与命令分开声明，但共用同一条判定与文案。 */
export const PANEL_ACTION_ACCESS = {
  resumeSession: ALWAYS_AVAILABLE,
  selectModel: idleOnly("切换模型"),
  saveConfig: idleOnly("修改模型配置"),
} as const;

export function accessDenial(access: TuiAccess, runtime: TuiRuntime): string | undefined {
  if (access.whileRunning === "allow") return undefined;
  const runActive =
    access.scope === "active" ? (runtime.activeRunActive ?? runtime.runActive) : runtime.runActive;
  if (runActive) {
    return `当前运行中，先按 Esc 中断或等待本轮结束后再${access.action}。`;
  }
  if (runtime.compactionActive) {
    return `正在压缩上下文，先按 Esc 取消或等待完成后再${access.action}。`;
  }
  return undefined;
}

export function assertAccessAllowed(access: TuiAccess, runtime: TuiRuntime): void {
  const denial = accessDenial(access, runtime);
  if (denial !== undefined) throw new Error(denial);
}
