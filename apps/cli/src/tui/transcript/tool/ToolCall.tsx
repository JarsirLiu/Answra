/** Claude-style tool row: action target, `⎿` result, bounded details, ctrl+o expand. */
import type { ConversationMessagePart } from "@answra/shared";
import { isToolFailed, isToolRunning, presentToolCall } from "@answra/ui/tool-presentation";
import { Box, Text } from "ink";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { summarizePresentation } from "../../../presentation/toolSummary";
import { BLACK_CIRCLE, SPINNER_FRAMES, TUI_THEME } from "../../chrome/theme";
import { SelectableText } from "../SelectableText";
import { ToolCallDetails } from "./ToolCallDetails";

type ToolPart = Extract<ConversationMessagePart, { kind: "tool" }>;

const LOADER_MS = 120;

const STATE_LABELS: Readonly<Record<ToolPart["state"], string>> = {
  "input-streaming": "preparing",
  pending: "pending",
  "awaiting-approval": "approval",
  running: "running",
  completed: "done",
  failed: "failed",
  denied: "denied",
  interrupted: "interrupted",
};

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
  const isOpen = expanded;
  const running = isToolRunning(part.state);
  const failed = isToolFailed(part.state) || presentation.errorText !== undefined;
  const summary = summarizePresentation(presentation);
  const hint = presentation.expandable && !isOpen ? " (ctrl+o to expand)" : "";

  return (
    <Box flexDirection="column" marginTop={nested ? 0 : 1} width="100%">
      <Box flexDirection="row" width="100%">
        <Box flexShrink={0} width={2}>
          {running ? (
            <ToolLoader />
          ) : (
            <Text color={failed ? TUI_THEME.error : TUI_THEME.text}>{BLACK_CIRCLE}</Text>
          )}
        </Box>
        <SelectableText>
          <Text bold color={failed ? TUI_THEME.error : TUI_THEME.text}>
            {summary.label}
          </Text>
          <Text>(</Text>
          <Text>{summary.target}</Text>
          <Text>)</Text>
          {summary.extra ? <Text dimColor>{summary.extra}</Text> : null}
          {failed ? <Text color={TUI_THEME.error}> · {STATE_LABELS[part.state]}</Text> : null}
        </SelectableText>
      </Box>
      {presentation.resultLine !== undefined || presentation.errorText !== undefined || hint ? (
        <ToolResultLine error={failed}>
          {presentation.errorText ?? presentation.resultLine ?? ""}
          <Text dimColor>{hint}</Text>
        </ToolResultLine>
      ) : null}
      {presentation.details.length > 0 ? (
        <ToolCallDetails expanded={isOpen} presentation={presentation} />
      ) : null}
    </Box>
  );
});

function ToolResultLine({ children, error }: { children: ReactNode; error: boolean }) {
  return (
    <Box flexDirection="row" width="100%">
      <Box flexShrink={0} width={5}>
        <Text color={error ? TUI_THEME.error : TUI_THEME.inactive}>{"  ⎿  "}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <SelectableText color={error ? TUI_THEME.error : undefined} dimColor={!error}>
          {children}
        </SelectableText>
      </Box>
    </Box>
  );
}

export function ToolLoader() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      LOADER_MS,
    );
    return () => clearInterval(timer);
  }, []);
  return <Text color={TUI_THEME.claude}>{SPINNER_FRAMES[frame]}</Text>;
}
