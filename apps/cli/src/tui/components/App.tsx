/** TUI 根布局：滚动 transcript + 活动行 + Claude 式输入框/状态行。 */
import { Box, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { TuiViewStore } from "../viewStore";
import type { WheelSource } from "../wheelInput";
import { PromptInput } from "./PromptInput";
import { Spinner } from "./Spinner";
import { StatusLine } from "./StatusLine";
import { VirtualTranscript } from "./VirtualTranscript";

export function App({
  store,
  botName,
  model,
  workspaceRoot,
  onSubmit,
  onCancel,
  onExitReady,
  wheelSource,
}: {
  store: TuiViewStore;
  botName: string;
  model: string;
  workspaceRoot: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onExitReady?: (exit: () => void) => void;
  wheelSource?: WheelSource;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const busy = state.phase !== "idle";
  const [expandThinking, setExpandThinking] = useState(false);

  useEffect(() => {
    onExitReady?.(exit);
  }, [exit, onExitReady]);

  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      setExpandThinking((value) => !value);
      return;
    }
    if (key.ctrl && input === "c" && busy) {
      onCancel();
      return;
    }
    if (key.escape && busy) onCancel();
  });

  return (
    <Box flexDirection="column" height={rows} width="100%">
      <VirtualTranscript
        expandThinking={expandThinking}
        footer={busy ? <Spinner phase={state.phase} queued={state.queued} /> : undefined}
        localError={state.localError}
        notice={state.notice}
        view={state.view}
        wheelSource={wheelSource}
        workspaceRoot={workspaceRoot}
      />
      <PromptInput busy={busy} onSubmit={onSubmit} />
      <StatusLine
        botName={botName}
        model={model}
        phase={state.phase}
        workspaceRoot={workspaceRoot}
      />
    </Box>
  );
}
