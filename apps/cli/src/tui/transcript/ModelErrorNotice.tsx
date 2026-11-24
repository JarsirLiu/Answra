/**
 * run 错误与重试提示：`⎿` gutter + 红色错误正文 + dim 重试行，对齐 Claude Code 的
 * SystemAPIErrorMessage；截断由 Ctrl+O 切换详细 transcript 展开。
 */
import type { ConversationRetry } from "@answra/ui/conversation-view";
import { Box } from "ink";
import { useEffect, useState } from "react";
import { TUI_THEME } from "../chrome/theme";
import { RESPONSE_GUTTER, RESPONSE_GUTTER_WIDTH } from "./gutter";
import { SelectableText } from "./SelectableText";

const MAX_ERROR_CHARS = 1000;
const TICK_MS = 250;
const EXPAND_HINT = "(ctrl+o to expand)";

export function ModelErrorNotice({
  error,
  localError,
  retry,
  expanded = false,
}: {
  error?: string;
  localError?: string;
  retry?: ConversationRetry;
  expanded?: boolean;
}) {
  const text = joinErrors(error, localError);
  if (text === undefined) {
    return retry === undefined ? null : (
      <Box flexDirection="column" marginTop={1}>
        <RetryLine key={retryKey(retry)} retry={retry} />
      </Box>
    );
  }
  const characters = Array.from(text);
  const truncated = !expanded && characters.length > MAX_ERROR_CHARS;
  const body = truncated ? `${characters.slice(0, MAX_ERROR_CHARS).join("")}…` : text;
  return (
    <Box flexDirection="row" marginTop={1} width="100%">
      <Box flexShrink={0} width={RESPONSE_GUTTER_WIDTH}>
        <SelectableText dimColor>{RESPONSE_GUTTER}</SelectableText>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <SelectableText color={TUI_THEME.error}>{body}</SelectableText>
        {truncated ? <SelectableText dimColor>{EXPAND_HINT}</SelectableText> : null}
        {retry === undefined ? null : <RetryLine key={retryKey(retry)} retry={retry} />}
      </Box>
    </Box>
  );
}

function retryKey(retry: ConversationRetry): string {
  return `${retry.kind}:${retry.attempt}`;
}

/** 同一条错误可能同时来自 turn 终态与本地发送失败，只保留一次。 */
function joinErrors(...errors: readonly (string | undefined)[]): string | undefined {
  const unique: string[] = [];
  for (const value of errors) {
    if (value === undefined || value.length === 0) continue;
    if (!unique.includes(value)) unique.push(value);
  }
  return unique.length === 0 ? undefined : unique.join("\n");
}

function RetryLine({ retry }: { retry: ConversationRetry }) {
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

  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [deadline]);

  if (retry.finished) {
    return (
      <SelectableText dimColor>
        重试已结束（{retry.attempt}/{retry.maxRetries}）
      </SelectableText>
    );
  }

  const waitText =
    remainingSeconds === undefined || remainingSeconds === 0
      ? "正在重试"
      : `${remainingSeconds} 秒后重试`;
  const status = retry.statusCode === undefined ? "" : `（HTTP ${retry.statusCode}）`;
  return (
    <SelectableText dimColor>
      {reasonOf(retry)}
      {status}
      {" · "}
      {waitText}
      {" · "}
      {retry.attempt}/{retry.maxRetries}
    </SelectableText>
  );
}

function reasonOf(retry: ConversationRetry): string {
  switch (retry.kind) {
    case "rate-limit":
      return "请求触发限流";
    case "server-error":
      return "模型服务暂时不可用";
    case "network-error":
      return "网络连接中断";
  }
}
