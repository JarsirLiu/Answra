/** 底部状态行：按列宽分配 Bot/模型、工作区与 run 阶段，窄终端只截断不换行。 */
import { Box, Text, useWindowSize } from "ink";
import type { TuiRunPhase } from "../viewStore";

const PHASE_WIDTH = 12;
const MIN_PATH_WIDTH = 8;
const MAX_PATH_WIDTH = 32;

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
}: {
  botName: string;
  model: string;
  workspaceRoot: string;
  phase: TuiRunPhase;
}) {
  const { columns } = useWindowSize();
  const pathWidth = Math.max(MIN_PATH_WIDTH, Math.min(MAX_PATH_WIDTH, Math.floor(columns * 0.32)));
  const leftWidth = Math.max(8, columns - pathWidth - PHASE_WIDTH);
  return (
    <Box flexDirection="row" width="100%">
      <Box flexShrink={0} width={leftWidth}>
        <Text dimColor wrap="truncate">
          {botName} · {model}
        </Text>
      </Box>
      <Box flexGrow={1} justifyContent="flex-end" minWidth={0}>
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
