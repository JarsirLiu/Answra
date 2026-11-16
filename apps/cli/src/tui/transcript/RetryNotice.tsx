/** 重试提示：说明原因、HTTP 状态、剩余等待与次数；只读取投影后的重试态。 */
import type { ConversationRetry } from "@answra/ui/conversation-view";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { TUI_THEME } from "../chrome/theme";

const TICK_MS = 250;

export function RetryNotice({ retry }: { retry: ConversationRetry }) {
  const [clock] = useState(() => {
    const startedAt = Date.now();
    return {
      now: startedAt,
      deadline: retry.delayMs === undefined ? undefined : startedAt + retry.delayMs,
    };
  });
  const [now, setNow] = useState(clock.now);
  const deadline = clock.deadline;
  const remainingSeconds =
    deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - now) / 1_000));
  const waitText =
    remainingSeconds === undefined || remainingSeconds === 0
      ? "正在重试"
      : `${remainingSeconds} 秒后重试`;

  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);

  if (retry.finished) {
    return (
      <Box marginTop={1}>
        <Text dimColor>
          重试已结束（{retry.attempt}/{retry.maxRetries}）
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={TUI_THEME.warning}>
        {reasonOf(retry)}
        {retry.statusCode === undefined ? "" : `（HTTP ${retry.statusCode}）`}
      </Text>
      <Text dimColor>
        {waitText}
        {" · "}
        {retry.attempt}/{retry.maxRetries}
      </Text>
    </Box>
  );
}

function reasonOf(retry: ConversationRetry): string {
  switch (retry.kind) {
    case "rate-limit":
      return "请求触发限流，等待后重试";
    case "server-error":
      return "模型服务暂时不可用，正在重试";
    case "network-error":
      return "网络连接中断，正在重试";
  }
}
