/** transcript 行：user 背景块，assistant 圆点缩进，工具卡保持自身 glyph。 */
import type { ConversationMessagePart } from "@answra/shared";
import type { ConversationViewMessage } from "@answra/ui/conversation-view";
import { Box, Text } from "ink";
import { memo } from "react";
import { TUI_THEME } from "../chrome/theme";
import { MarkdownText } from "./MarkdownText";
import { MessageResponse } from "./MessageResponse";
import { groupMessageParts } from "./tool/groups/groupToolCalls";
import { ToolGroupRow } from "./tool/groups/ToolGroupRow";
import { ToolCall } from "./tool/ToolCall";

export const MessageRow = memo(function MessageRow({
  message,
  expandThinking = false,
  showReasoning = true,
  expandedToolIds,
}: {
  message: ConversationViewMessage;
  expandThinking?: boolean;
  showReasoning?: boolean;
  expandedToolIds?: ReadonlySet<string>;
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
      {renderParts(message, expandThinking, showReasoning, expandedToolIds)}
    </Box>
  );
});

function renderParts(
  message: ConversationViewMessage,
  expandThinking: boolean,
  showReasoning: boolean,
  expandedToolIds: ReadonlySet<string> | undefined,
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
      <ToolGroupRow
        expanded={expandThinking || expandedToolIds?.has(part.id) === true}
        group={part}
        key={part.id}
      />
    ) : (
      <PartRow
        expandThinking={expandThinking}
        expandedToolIds={expandedToolIds}
        key={part.id}
        part={part}
        showReasoning={showReasoning}
      />
    ),
  );
}

function PartRow({
  part,
  expandThinking,
  showReasoning,
  expandedToolIds,
}: {
  part: ConversationMessagePart;
  expandThinking: boolean;
  showReasoning: boolean;
  expandedToolIds: ReadonlySet<string> | undefined;
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
  return (
    <ToolCall expanded={expandThinking || expandedToolIds?.has(part.id) === true} part={part} />
  );
}
