/** TUI 根布局：滚动 transcript + 活动行 + Claude 式输入框/状态行。 */
import { contextCompactionLabel } from "@answra/ui/conversation-view";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Spinner } from "../chrome/Spinner";
import { StatusLine } from "../chrome/StatusLine";
import { PromptInput } from "../composer/PromptInput";
import type { PointerSource } from "../interaction/pointerInput";
import type { TuiSelectionStore } from "../interaction/selectionStore";
import type { TuiSetupStep } from "../modelSetup";
import { SelectionContext } from "../transcript/SelectableText";
import { VirtualTranscript } from "../transcript/VirtualTranscript";
import type { TuiViewStore } from "./viewStore";

const NO_SUBSCRIBE = () => () => {};
const ZERO_VERSION = () => 0;
const SETUP_HINTS: Record<TuiSetupStep, string> = {
  "base-url": "输入 Base URL，例如 http://127.0.0.1:11434/v1 · Enter 继续",
  "api-key": "输入 API Key，本地端点可留空 · Enter 继续",
  "model-id": "输入模型 ID，例如 qwen2.5-coder:7b · Enter 完成",
};

export function App({
  store,
  botName,
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
  const compaction = state.view.contextCompaction;
  const compactionLabel = compaction ? contextCompactionLabel(compaction) : "";
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
          footer={
            busy ? (
              <Spinner phase={state.phase} queued={state.queued} />
            ) : compactionLabel ? (
              <Box paddingX={1}>
                <Text color={compaction?.state === "failed" ? "red" : "gray"} wrap="truncate">
                  {compactionLabel}
                </Text>
              </Box>
            ) : undefined
          }
          localError={state.localError}
          modelConfigured={state.modelConfigured}
          notice={state.notice}
          onScroll={onClearSelection}
          pointerSource={pointerSource}
          setupStep={state.setupStep}
          view={state.view}
          workspaceRoot={workspaceRoot}
        />
        <PromptInput
          allowEmptySubmit={state.setupStep === "api-key"}
          busy={busy}
          idleHint={state.setupStep === undefined ? undefined : SETUP_HINTS[state.setupStep]}
          onSubmit={onSubmit}
          secret={state.setupStep === "api-key"}
          selectionActive={hasSelection}
        />
        <StatusLine
          botName={botName}
          model={state.modelLabel}
          phase={state.phase}
          workspaceRoot={workspaceRoot}
        />
      </Box>
    </SelectionContext.Provider>
  );
}
