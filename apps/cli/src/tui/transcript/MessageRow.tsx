/** Claude 风格 transcript 行：user 背景块，assistant 圆点缩进，工具卡保持自身 glyph。 */
import type { ConversationMessagePart } from "@answra/shared";
import type { ConversationViewMessage } from "@answra/ui/conversation-view";
import { Box, Text } from "ink";
import { memo } from "react";
import { BLACK_CIRCLE, TUI_THEME } from "../chrome/theme";
import { MarkdownText } from "./MarkdownText";
import { MessageResponse } from "./MessageResponse";
import { SelectableText } from "./SelectableText";
import { groupMessageParts, type ToolGroup } from "./tool/groupToolCalls";
import { ToolCall, ToolLoader } from "./tool/ToolCall";

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
  return groupMessageParts(parts).map((part) =>
    part.kind === "tool-group" ? (
      <ToolGroupRow expandThinking={expandThinking} group={part} key={part.id} />
    ) : (
      <PartRow
        expandThinking={expandThinking}
        key={part.id}
        part={part}
        showReasoning={showReasoning}
      />
    ),
  );
}

function ToolGroupRow({ group, expandThinking }: { group: ToolGroup; expandThinking: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      <Box flexDirection="row" width="100%">
        <Box flexShrink={0} width={2}>
          {group.running ? (
            <ToolLoader />
          ) : (
            <Text color={group.failed ? TUI_THEME.error : TUI_THEME.text}>{BLACK_CIRCLE}</Text>
          )}
        </Box>
        <SelectableText>
          <Text bold color={group.failed ? TUI_THEME.error : TUI_THEME.text}>
            {group.label}
          </Text>
          {!expandThinking && group.expandable ? <Text dimColor> (ctrl+o to expand)</Text> : null}
        </SelectableText>
      </Box>
      {expandThinking
        ? group.parts.map((part) => <ToolCall expanded key={part.id} nested part={part} />)
        : null}
    </Box>
  );
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
  return <ToolCall expanded={expandThinking} part={part} />;
}
