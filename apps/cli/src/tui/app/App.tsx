/** TUI 根布局：滚动 transcript + 活动行 + Claude 式输入框/状态行。 */
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ImageAttachment } from "../../image/attachment";
import type { ImageAttachmentReader } from "../../image/ports";
import { Spinner } from "../chrome/Spinner";
import { StatusLine } from "../chrome/StatusLine";
import { TUI_THEME } from "../chrome/theme";
import { PromptInput } from "../composer/PromptInput";
import type { PointerSource } from "../interaction/pointerInput";
import type { TuiSelectionStore } from "../interaction/selectionStore";
import type { TuiSetupStep } from "../modelSetup";
import { NotificationLine } from "../notices/NotificationLine";
import { ConfigPanel } from "../panels/ConfigPanel";
import { HelpPanel } from "../panels/HelpPanel";
import { ModelPicker } from "../panels/ModelPicker";
import type { TuiPanelHandlers } from "../panels/panel";
import { SessionsPanel } from "../panels/SessionsPanel";
import { StatusPanel } from "../panels/StatusPanel";
import { ContextPruningNotice } from "../transcript/ContextPruningNotice";
import { COMPACTION_FAILURE_TEXT, COMPACTION_SPINNER_MESSAGE } from "../transcript/compactionText";
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
  onCopyText,
  onSelectAll,
  onClearSelection,
  imageReader,
  onPasteError,
  panelHandlers,
}: {
  store: TuiViewStore;
  botName: string;
  workspaceRoot: string;
  onSubmit: (text: string, images?: readonly ImageAttachment[]) => void;
  onCancel: () => void;
  imageReader?: ImageAttachmentReader;
  onPasteError?: (message: string) => void;
  onExitReady?: (exit: () => void) => void;
  pointerSource?: PointerSource;
  selectionStore?: TuiSelectionStore;
  onCopySelection?: () => void;
  onCopyText?: (text: string) => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
  panelHandlers: TuiPanelHandlers;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const compaction = state.view.contextCompaction;
  const compacting = state.compactionActive || compaction?.state === "started";
  const busy = state.phase !== "idle" || compacting;
  const compactionFailed = compaction?.state === "failed";
  const [transcriptMode, setTranscriptMode] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  useSyncExternalStore(
    selectionStore?.subscribe ?? NO_SUBSCRIBE,
    selectionStore?.getVersion ?? ZERO_VERSION,
  );
  const hasSelection = selectionStore?.hasSelection() ?? false;

  useEffect(() => {
    onExitReady?.(exit);
  }, [exit, onExitReady]);

  useEffect(() => {
    if (state.panel !== undefined) setCommandPaletteOpen(false);
  }, [state.panel]);

  useInput(
    (input, key) => {
      if (commandPaletteOpen && key.escape) return;
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
        setTranscriptMode((current) => !current);
        return;
      }
      if (key.ctrl && input === "c" && busy) {
        onCancel();
        return;
      }
      if (key.escape && busy) onCancel();
    },
    { isActive: state.panel === undefined },
  );

  return (
    <SelectionContext.Provider value={selectionStore}>
      <Box flexDirection="column" height={rows} width="100%">
        <VirtualTranscript
          compactionBoundaries={state.compactionBoundaries}
          transcriptMode={transcriptMode}
          footer={
            busy || compactionFailed || state.view.contextPruning ? (
              <Box flexDirection="column">
                {compactionFailed ? (
                  <Box paddingX={1}>
                    <Text color={TUI_THEME.error} wrap="truncate">
                      {COMPACTION_FAILURE_TEXT}
                    </Text>
                  </Box>
                ) : null}
                {!busy && state.view.contextPruning ? (
                  <ContextPruningNotice status={state.view.contextPruning} />
                ) : null}
                {busy ? (
                  <Spinner
                    color={compacting ? TUI_THEME.compaction : undefined}
                    message={compacting ? COMPACTION_SPINNER_MESSAGE : undefined}
                    phase={state.phase}
                    queued={state.queued}
                  />
                ) : null}
              </Box>
            ) : undefined
          }
          localError={state.localError}
          modelConfigured={state.modelConfigured}
          pointerSource={pointerSource}
          setupStep={state.setupStep}
          view={state.view}
          workspaceRoot={workspaceRoot}
        />
        <NotificationLine notification={state.notifications.current} />
        {transcriptMode ? (
          <Box paddingX={1}>
            <Text dimColor wrap="truncate">
              Showing detailed transcript · ctrl+o to toggle
            </Text>
          </Box>
        ) : null}
        {state.panel === "config" ? (
          <ConfigPanel
            close={panelHandlers.close}
            load={panelHandlers.loadConfig}
            save={panelHandlers.saveConfig}
          />
        ) : state.panel === "model" ? (
          <ModelPicker
            close={panelHandlers.close}
            load={panelHandlers.loadModels}
            select={panelHandlers.selectModel}
          />
        ) : state.panel === "sessions" ? (
          <SessionsPanel
            close={() => panelHandlers.close("resumed")}
            load={panelHandlers.loadSessions}
            resume={panelHandlers.resumeSession}
          />
        ) : state.panel === "status" ? (
          <StatusPanel
            account={state.authAccount}
            authAvailable={state.authAvailable}
            close={() => panelHandlers.close("status")}
            contextUsage={state.view.contextUsage}
            model={state.modelLabel}
            signedIn={state.authSignedIn}
            workspaceRoot={workspaceRoot}
          />
        ) : state.panel === "help" ? (
          <HelpPanel close={() => panelHandlers.close()} />
        ) : (
          <PromptInput
            allowEmptySubmit={state.setupStep === "api-key"}
            busy={busy}
            idleHint={state.setupStep === undefined ? undefined : SETUP_HINTS[state.setupStep]}
            imageReader={state.setupStep === undefined ? imageReader : undefined}
            onCommandPaletteChange={setCommandPaletteOpen}
            onCopyText={onCopyText}
            onPasteError={onPasteError}
            onSubmit={onSubmit}
            secret={state.setupStep === "api-key"}
            selectionActive={hasSelection}
          />
        )}
        <StatusLine
          botName={botName}
          contextUsage={state.view.contextUsage}
          model={state.modelLabel}
          phase={state.phase}
          workspaceRoot={workspaceRoot}
        />
      </Box>
    </SelectionContext.Provider>
  );
}
