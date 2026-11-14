/** Animated tool spinner; isolated so header and group rows share one timer. */
import { Text } from "ink";
import { useEffect, useState } from "react";
import { SPINNER_FRAMES, TUI_THEME } from "./theme";

const LOADER_MS = 120;

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
