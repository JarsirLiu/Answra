/** 本地排队输入投影：显示待发送正文，但不写入 transcript 或伪装成已启动的 run。 */
import { Box, Text } from "ink";
import type { TuiQueuedPrompt } from "../app/viewStore";
import { TUI_THEME } from "../chrome/theme";
import { MarkdownText } from "./markdown/MarkdownText";

export function QueuedPrompts({ prompts }: { prompts: readonly TuiQueuedPrompt[] }) {
  if (prompts.length === 0) return null;
  return (
    <Box flexDirection="column">
      {prompts.map((prompt) => (
        <Box flexDirection="column" key={prompt.id} marginTop={1}>
          <Box paddingX={1}>
            <Text color={TUI_THEME.suggestion} dimColor>
              {prompt.status === "sending" ? "正在发送…" : "已排队 · 当前回合结束后发送"}
            </Text>
          </Box>
          <Box
            backgroundColor={TUI_THEME.userMessageBackground}
            flexDirection="column"
            paddingX={1}
          >
            {prompt.text.length > 0 ? <MarkdownText text={prompt.text} /> : null}
            {prompt.imageCount > 0 ? <Text dimColor>{`[${prompt.imageCount} 张图片]`}</Text> : null}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
