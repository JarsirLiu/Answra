import type { AgentConnectionState } from "@answra/shared";
import { Wifi } from "lucide-react";
import { ICON_SM } from "../../tokens";
import styles from "./ConnectionNotice.module.css";

export const AGENT_SERVICE_UNAVAILABLE_NOTICE = "本地 AI 服务暂不可用，请稍后重试";

interface ConnectionNoticeProps {
  state?: AgentConnectionState;
}

/**
 * Agent worker 链路提示：只表达连接域状态，不承载模型失败。
 * 调用方按连接域优先级决定是否同时渲染模型重试/错误提示。
 */
export function ConnectionNotice({ state }: ConnectionNoticeProps) {
  const text = formatConnectionNotice(state);
  if (!state || !text) return null;
  const unavailable = state.status === "unavailable";
  return (
    <div
      aria-live={unavailable ? undefined : "polite"}
      className={styles.notice}
      data-status={state.status}
      role={unavailable ? "alert" : "status"}
    >
      <Wifi aria-hidden="true" className={unavailable ? undefined : styles.icon} size={ICON_SM} />
      <span className={styles.text}>{text}</span>
    </div>
  );
}

/** 启动阶段的静默由 `useConnectionState` 负责；连接成功后的重连计数仍要可见。 */
export function formatConnectionNotice(
  state: AgentConnectionState | undefined,
): string | undefined {
  if (state?.status === "reconnecting") {
    return `本地 AI 服务未连接，正在重连 ${state.attempt}/${state.maxAttempts}`;
  }
  if (state?.status === "unavailable") return AGENT_SERVICE_UNAVAILABLE_NOTICE;
  return undefined;
}
