/** 底部状态行：Bot/模型可收缩，上下文百分比与阶段固定可见，工作区只占剩余列并截断中间。 */
import type { ContextUsage } from "@answra/shared";
import { contextUsagePercent } from "@answra/ui/conversation-view";
import { Box, Text } from "ink";
import type { TuiRunPhase } from "../app/viewStore";

const PHASE_WIDTH = 12;

const PHASE_LABELS: Readonly<Record<TuiRunPhase, string>> = {
  idle: "idle",
  running: "running",
  cancelling: "cancelling",
};

export function StatusLine({
  botName,
  model,
  workspaceRoot,
  phase,
  contextUsage,
}: {
  botName: string;
  model: string;
  workspaceRoot: string;
  phase: TuiRunPhase;
  contextUsage?: ContextUsage;
}) {
  const context = contextUsage ? `ctx ${contextUsagePercent(contextUsage)}%` : undefined;
  return (
    <Box flexDirection="row" width="100%">
      <Box flexShrink={1} minWidth={0}>
        <Text dimColor wrap="truncate">
          {botName} · {model}
        </Text>
      </Box>
      {context !== undefined ? (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{context}</Text>
        </Box>
      ) : null}
      <Box flexGrow={1} flexShrink={1} minWidth={0} justifyContent="flex-end" marginLeft={1}>
        <Text dimColor wrap="truncate-middle">
          {workspaceRoot}
        </Text>
      </Box>
      <Box flexShrink={0} justifyContent="flex-end" width={PHASE_WIDTH}>
        <Text color={phase === "idle" ? "gray" : "yellow"} wrap="truncate">
          {PHASE_LABELS[phase]}
        </Text>
      </Box>
    </Box>
  );
}
