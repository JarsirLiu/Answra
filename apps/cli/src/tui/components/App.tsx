/** TUI 根布局：滚动 transcript + 活动行 + Claude 式输入框/状态行。 */
import { Box, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PointerSource } from "../interaction/pointerInput";
import type { TuiSelectionStore } from "../interaction/selectionStore";
import type { TuiViewStore } from "../viewStore";
import { PromptInput } from "./PromptInput";
import { SelectionContext } from "./SelectableText";
import { Spinner } from "./Spinner";
import { StatusLine } from "./StatusLine";
import { VirtualTranscript } from "./VirtualTranscript";

const NO_SUBSCRIBE = () => () => {};
const ZERO_VERSION = () => 0;

export function App({
  store,
  botName,
  model,
  workspaceRoot,
  onSubmit,
  onCancel,
  onExitReady,
  pointerSource,
  selectionStore,
  onCopySelection,
  onSelectAll,
  onClearSelection,
}: {
  store: TuiViewStore;
  botName: string;
  model: string;
  workspaceRoot: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onExitReady?: (exit: () => void) => void;
  pointerSource?: PointerSource;
  selectionStore?: TuiSelectionStore;
  onCopySelection?: () => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const busy = state.phase !== "idle";
  const [expandThinking, setExpandThinking] = useState(false);
  useSyncExternalStore(
    selectionStore?.subscribe ?? NO_SUBSCRIBE,
    selectionStore?.getVersion ?? ZERO_VERSION,
  );
  const hasSelection = selectionStore?.hasSelection() ?? false;

  useEffect(() => {
    onExitReady?.(exit);
  }, [exit, onExitReady]);

  useInput((input, key) => {
    const shortcut = input.toLowerCase();
    if (
      onCopySelection !== undefined &&
      ((key.ctrl && key.shift && shortcut === "c") || (key.super && shortcut === "c"))
    ) {
      onCopySelection();
      return;
    }
    if (onSelectAll !== undefined && key.ctrl && key.shift && shortcut === "a") {
      onSelectAll();
      return;
    }
    if (onClearSelection !== undefined && key.escape && hasSelection) {
      onClearSelection();
      return;
    }
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
    <SelectionContext.Provider value={selectionStore}>
      <Box flexDirection="column" height={rows} width="100%">
        <VirtualTranscript
          expandThinking={expandThinking}
          footer={busy ? <Spinner phase={state.phase} queued={state.queued} /> : undefined}
          localError={state.localError}
          notice={state.notice}
          onScroll={onClearSelection}
          pointerSource={pointerSource}
          view={state.view}
          workspaceRoot={workspaceRoot}
        />
        <PromptInput busy={busy} onSubmit={onSubmit} selectionActive={hasSelection} />
        <StatusLine
          botName={botName}
          model={model}
          phase={state.phase}
          workspaceRoot={workspaceRoot}
        />
      </Box>
    </SelectionContext.Provider>
  );
}
