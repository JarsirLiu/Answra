/** Claude 风格 transcript 行：user 背景块，assistant 圆点缩进，工具卡保持自身 glyph。 */
import type { ConversationMessagePart } from "@answra/shared";
import type { ConversationViewMessage } from "@answra/ui/conversation-view";
import { Box, Text } from "ink";
import { memo } from "react";
import { TUI_THEME } from "../theme";
import { MarkdownText } from "./MarkdownText";
import { MessageResponse } from "./MessageResponse";
import { ToolCard } from "./ToolCard";

export const MessageRow = memo(function MessageRow({
  message,
  expandThinking = false,
  showReasoning = true,
}: {
  message: ConversationViewMessage;
  expandThinking?: boolean;
  showReasoning?: boolean;
}) {
  if (message.role === "user") {
    return (
      <Box
        backgroundColor={TUI_THEME.userMessageBackground}
        flexDirection="column"
        marginTop={1}
        paddingX={1}
      >
        <MarkdownText text={message.text} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      {renderParts(message, expandThinking, showReasoning)}
    </Box>
  );
});

function renderParts(
  message: ConversationViewMessage,
  expandThinking: boolean,
  showReasoning: boolean,
) {
  const parts = message.parts ?? [];
  if (parts.length === 0) {
    return message.text.length === 0 ? null : (
      <MessageResponse>
        <MarkdownText text={message.text} />
      </MessageResponse>
    );
  }
  return parts.map((part) => (
    <PartRow
      expandThinking={expandThinking}
      key={part.id}
      part={part}
      showReasoning={showReasoning}
    />
  ));
}

function PartRow({
  part,
  expandThinking,
  showReasoning,
}: {
  part: ConversationMessagePart;
  expandThinking: boolean;
  showReasoning: boolean;
}) {
  if (part.kind === "text") {
    return (
      <MessageResponse>
        <MarkdownText text={part.text} />
      </MessageResponse>
    );
  }
  if (part.kind === "reasoning") {
    if (!showReasoning) return null;
    return (
      <Box flexDirection="column">
        <MessageResponse dim>
          <Text dimColor italic>
            {"∴ Thinking"}
            {expandThinking ? null : <Text dimColor> (ctrl+o to expand)</Text>}
          </Text>
        </MessageResponse>
        {expandThinking && part.text.length > 0 ? (
          <Box paddingLeft={2}>
            <MarkdownText dimColor text={part.text} />
          </Box>
        ) : null}
      </Box>
    );
  }
  return <ToolCard expanded={expandThinking} part={part} />;
}
