/** Tool row composition: header, result line, and bounded details. */
import type { ConversationMessagePart } from "@answra/shared";
import { isToolFailed, isToolRunning, presentToolCall } from "@answra/ui/tool-presentation";
import { Box } from "ink";
import { memo, useMemo } from "react";
import { summarizePresentation } from "../../../presentation/toolSummary";
import { ToolCallHeader } from "./ToolCallHeader";
import { ToolDetails } from "./ToolDetails";
import { ToolResultLine } from "./ToolResultLine";
import { TOOL_EXPAND_HINT } from "./toolLayout";

type ToolPart = Extract<ConversationMessagePart, { kind: "tool" }>;

export const ToolCall = memo(function ToolCall({
  part,
  expanded = false,
  nested = false,
}: {
  part: ToolPart;
  expanded?: boolean;
  nested?: boolean;
}) {
  const presentation = useMemo(
    () =>
      presentToolCall({
        toolName: part.toolName,
        state: part.state,
        input: part.input,
        inputText: part.inputText,
        output: part.output,
        errorText: part.errorText,
        title: part.title,
      }),
    [part],
  );
  const running = isToolRunning(part.state);
  const failed = isToolFailed(part.state) || presentation.errorText !== undefined;
  const summary = summarizePresentation(presentation);
  const hint = presentation.expandable && !expanded ? TOOL_EXPAND_HINT : undefined;
  const showResult =
    presentation.resultLine !== undefined ||
    presentation.errorText !== undefined ||
    hint !== undefined;

  return (
    <Box flexDirection="column" marginTop={nested ? 0 : 1} width="100%">
      <ToolCallHeader failed={failed} running={running} state={part.state} summary={summary} />
      {showResult ? (
        <ToolResultLine
          error={failed}
          errorText={presentation.errorText}
          hint={hint}
          resultLine={presentation.resultLine}
        />
      ) : null}
      {presentation.details.length > 0 ? (
        <ToolDetails expanded={expanded} presentation={presentation} />
      ) : null}
    </Box>
  );
});
