/** transcript 内容投影：Claude 风格欢迎区、消息列表与 run 错误/重试行。 */
import type { ConversationView } from "@answra/ui/conversation-view";
import { Box, Text } from "ink";
import { TUI_THEME } from "../theme";
import { MessageRow } from "./MessageRow";

export function Transcript({
  view,
  localError,
  notice,
  workspaceRoot,
  expandThinking,
}: {
  view: ConversationView;
  localError?: string;
  notice?: readonly string[];
  workspaceRoot: string;
  expandThinking?: boolean;
}) {
  return (
    <Box flexDirection="column">
      {view.messages.length === 0 ? <Welcome workspaceRoot={workspaceRoot} /> : null}
      {view.messages.map((message) => (
        <MessageRow key={message.id} expandThinking={expandThinking} message={message} />
      ))}
      <TranscriptTail localError={localError} notice={notice} view={view} />
    </Box>
  );
}

export function Welcome({ workspaceRoot }: { workspaceRoot: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={TUI_THEME.claude}>
        ✻ Welcome to Answra Code!
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{workspaceRoot}</Text>
        <Text dimColor>输入任务开始会话。工具会直接在当前工作区执行。</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text bold>1.</Text> 描述目标，让 Agent 自己搜索、阅读并修改代码
        </Text>
        <Text>
          <Text bold>2.</Text> 用 Esc 中断当前运行，Ctrl-C 两次退出
        </Text>
        <Text>
          <Text bold>3.</Text> Enter 发送或排队，Ctrl+O 展开思考与工具输出，PgUp/PgDn 滚动， /help
          查看命令
        </Text>
      </Box>
    </Box>
  );
}

export function TranscriptTail({
  view,
  localError,
  notice,
}: {
  view: ConversationView;
  localError?: string;
  notice?: readonly string[];
}) {
  return (
    <>
      {notice === undefined ? null : (
        <Box flexDirection="column" marginTop={1}>
          {notice.map((line) => (
            <Text key={line} color={TUI_THEME.suggestion}>
              {line}
            </Text>
          ))}
        </Box>
      )}
      {view.retry === undefined ? null : (
        <Box flexDirection="row" marginTop={1}>
          <Text color={TUI_THEME.warning}>retry </Text>
          <Text dimColor>
            {view.retry.attempt}/{view.retry.maxRetries}
            {view.retry.finished ? " failed" : "…"}
          </Text>
        </Box>
      )}
      {view.error === undefined ? null : <Text color={TUI_THEME.error}>{view.error}</Text>}
      {localError === undefined ? null : <Text color={TUI_THEME.error}>{localError}</Text>}
    </>
  );
}
