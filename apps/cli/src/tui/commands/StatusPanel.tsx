/** `/status` 面板：展示当前会话、模型、上下文用量与 Answra 账户状态；不显示令牌。 */
import type { ContextUsage } from "@answra/shared";
import { contextUsagePercent, formatContextTokens } from "@answra/ui/conversation-view";
import { Box, Text, useInput } from "ink";
import { CLI_VERSION } from "../../version";
import { PanelFrame } from "../chrome/PanelFrame";
import { TUI_THEME } from "../chrome/theme";
import { accountLabel, accountState } from "../sessionSummary";

export function StatusPanel({
  account,
  authAvailable = false,
  signedIn,
  model,
  workspaceRoot,
  contextUsage,
  close,
}: {
  account?: string;
  authAvailable?: boolean;
  signedIn: boolean;
  model: string;
  workspaceRoot: string;
  contextUsage?: ContextUsage;
  close(): void;
}) {
  useInput((_input, key) => {
    if (key.escape || key.return) close();
  });
  const accountText = accountLabel(
    accountState({ authAvailable, authSignedIn: signedIn, authAccount: account }),
  );

  return (
    <PanelFrame title="状态" footer="Enter/Esc 关闭">
      <Box flexDirection="column" gap={1}>
        <StatusRow label="版本" value={CLI_VERSION} />
        <StatusRow label="账户" value={accountText} />
        <StatusRow label="模型" value={model || "未配置"} />
        <StatusRow label="上下文" value={contextLabel(contextUsage)} />
        <StatusRow label="工作区" value={workspaceRoot} />
        {!authAvailable ? (
          <Text dimColor>当前构建未启用账户登录。</Text>
        ) : !signedIn ? (
          <Text color={TUI_THEME.suggestion}>运行 /login 打开浏览器登录 Answra 账号。</Text>
        ) : null}
      </Box>
    </PanelFrame>
  );
}

function contextLabel(usage: ContextUsage | undefined): string {
  if (usage === undefined) return "尚未准备请求";
  return `${contextUsagePercent(usage)}%（${formatContextTokens(usage.usedTokens)} / ${formatContextTokens(
    usage.inputLimit,
  )}）`;
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text dimColor>{`${label.padEnd(10)} `}</Text>
      <Text>{value}</Text>
    </Box>
  );
}
