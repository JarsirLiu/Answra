/** Claude 风格活动行：旋转 glyph、随机动词、耗时与中断提示；只投影 run 阶段。 */
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { SPINNER_FRAMES, TUI_THEME } from "../theme";
import type { TuiRunPhase } from "../viewStore";

const VERBS = [
  "Accomplishing",
  "Architecting",
  "Baking",
  "Brewing",
  "Calculating",
  "Cerebrating",
  "Churning",
  "Cogitating",
  "Composing",
  "Concocting",
  "Considering",
  "Cooking",
  "Crafting",
  "Crunching",
  "Deciphering",
  "Deliberating",
  "Determining",
  "Envisioning",
  "Forging",
  "Generating",
  "Hashing",
  "Hatching",
  "Inferring",
  "Manifesting",
  "Mulling",
  "Noodling",
  "Percolating",
  "Pondering",
  "Processing",
  "Puzzling",
  "Reticulating",
  "Ruminating",
  "Sketching",
  "Synthesizing",
  "Thinking",
  "Tinkering",
  "Unravelling",
  "Whirring",
  "Working",
  "Wrangling",
] as const;

const FRAME_MS = 120;

export function Spinner({ phase, queued }: { phase: TuiRunPhase; queued: number }) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [verb] = useState(() => sampleVerb());
  const [startedAt] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [startedAt]);

  const glyph = phase === "cancelling" ? "·" : SPINNER_FRAMES[frame];
  return (
    <Box flexDirection="row" marginTop={1} width="100%">
      <Box flexShrink={0} width={2}>
        <Text color={TUI_THEME.claude}>{glyph}</Text>
      </Box>
      <Text color={TUI_THEME.claude}>{phase === "cancelling" ? "Stopping…" : `${verb}…`}</Text>
      <Text dimColor>
        {" "}
        ({elapsed}s · {phase === "cancelling" ? "waiting for tools to stop" : "esc to interrupt"})
      </Text>
      {queued > 0 ? <Text color={TUI_THEME.suggestion}> · {queued} queued</Text> : null}
    </Box>
  );
}

function sampleVerb(): string {
  return VERBS[Math.floor(Math.random() * VERBS.length)] ?? "Working";
}
