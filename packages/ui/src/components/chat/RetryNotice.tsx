import { Wifi } from "lucide-react";
import { ICON_SM } from "../../tokens";
import type { ConversationRetry } from "./conversationMessage";
import styles from "./RetryNotice.module.css";

interface RetryNoticeProps {
  retry: ConversationRetry;
}

/** 同一条消息内的原地重试状态：只更新计数，不新增消息或浮层。 */
export function RetryNotice({ retry }: RetryNoticeProps) {
  const message =
    retry.kind === "rate-limit"
      ? "请求触发限流，正在等待后重试"
      : retry.kind === "network-error"
        ? "网络连接中断，正在重试"
        : "模型服务暂时不可用，正在重试";
  return (
    <div
      aria-label={retry.finished ? "重试已结束" : undefined}
      aria-live="polite"
      className={styles.notice}
      role="status"
    >
      <Wifi
        aria-hidden="true"
        className={retry.finished ? undefined : styles.icon}
        size={ICON_SM}
      />
      {!retry.finished && (
        <span className={styles.text}>
          {message} {retry.attempt}/{retry.maxRetries}
        </span>
      )}
    </div>
  );
}
