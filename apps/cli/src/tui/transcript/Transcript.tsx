/** transcript 内容投影：Claude 风格欢迎区、消息列表与 run 错误/重试行。 */
import type { ConversationView } from "@answra/ui/conversation-view";
import { Box, Text } from "ink";
import { TUI_THEME } from "../chrome/theme";
import type { TuiSetupStep } from "../modelSetup";
import { MessageRow } from "./MessageRow";
import { ModelSetupPanel } from "./ModelSetupPanel";
import { RetryNotice } from "./RetryNotice";
import { SelectableText } from "./SelectableText";

export function Transcript({
  view,
  localError,
  notice,
  workspaceRoot,
  modelConfigured = true,
  setupStep,
  expandThinking,
  expandedToolIds,
}: {
  view: ConversationView;
  localError?: string;
  notice?: readonly string[];
  workspaceRoot: string;
  modelConfigured?: boolean;
  setupStep?: TuiSetupStep;
  expandThinking?: boolean;
  expandedToolIds?: ReadonlySet<string>;
}) {
  return (
    <Box flexDirection="column">
      {view.messages.length === 0 ? (
        <Welcome
          modelConfigured={modelConfigured}
          setupStep={setupStep}
          workspaceRoot={workspaceRoot}
        />
      ) : null}
      {view.messages.map((message) => (
        <MessageRow
          expandedToolIds={expandedToolIds}
          expandThinking={expandThinking}
          key={message.id}
          message={message}
        />
      ))}
      <TranscriptTail localError={localError} notice={notice} view={view} />
    </Box>
  );
}

export function Welcome({
  workspaceRoot,
  modelConfigured = true,
  setupStep,
}: {
  workspaceRoot: string;
  modelConfigured?: boolean;
  setupStep?: TuiSetupStep;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SelectableText bold color={TUI_THEME.claude}>
        ⏺ 欢迎使用 Answra Code！
      </SelectableText>
      {modelConfigured ? (
        <>
          <Box marginTop={1} flexDirection="column">
            <SelectableText dimColor>{workspaceRoot}</SelectableText>
            <SelectableText dimColor>输入任务开始会话。工具会直接在当前工作区执行。</SelectableText>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <SelectableText>
              <Text bold>1.</Text> 描述目标，让 Agent 自己搜索、阅读并修改代码
            </SelectableText>
            <SelectableText>
              <Text bold>2.</Text> 按 Esc 中断当前运行，Ctrl-C 两次退出
            </SelectableText>
            <SelectableText>
              <Text bold>3.</Text> Enter 发送或排队，Ctrl+O 切换详细 transcript，PgUp/PgDn
              滚动；/help 查看命令
            </SelectableText>
          </Box>
        </>
      ) : (
        <ModelSetupPanel step={setupStep} />
      )}
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
            <SelectableText key={line} color={TUI_THEME.suggestion}>
              {line}
            </SelectableText>
          ))}
        </Box>
      )}
      {view.retry === undefined ? null : (
        <RetryNotice key={`${view.retry.kind}:${view.retry.attempt}`} retry={view.retry} />
      )}
      {view.error === undefined ? null : (
        <SelectableText color={TUI_THEME.error}>{view.error}</SelectableText>
      )}
      {localError === undefined ? null : (
        <SelectableText color={TUI_THEME.error}>{localError}</SelectableText>
      )}
    </>
  );
}
