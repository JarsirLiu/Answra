/** Ink TUI 运行器：挂载 App，驱动 CodingSession 的排队发送、等待与取消。 */
import { render } from "ink";
import type { CodingSession } from "../session/codingSession";
import { parseTuiCommand, TUI_HELP_LINES, type TuiCommand } from "./commands";
import { App } from "./components/App";
import { createClipboardWriter } from "./interaction/clipboard";
import { createPointerInput } from "./interaction/pointerInput";
import { createSelectionActions } from "./interaction/selectionActions";
import { TuiSelectionStore } from "./interaction/selectionStore";
import type { TuiViewStore } from "./viewStore";

export interface TuiRunOptions {
  session: CodingSession;
  store: TuiViewStore;
  botName: string;
  model: string;
  workspaceRoot: string;
  altScreen: boolean;
}

export type TuiRunner = (options: TuiRunOptions) => Promise<number>;

export function createInkTuiRunner(): TuiRunner {
  return runInkTui;
}

export async function runInkTui({
  session,
  store,
  botName,
  model,
  workspaceRoot,
  altScreen,
}: TuiRunOptions): Promise<number> {
  store.initialize(await session.open());
  const queue: string[] = [];
  let busy = false;
  let cancelRequested = false;
  let exitTui: (() => void) | undefined;

  const submit = (text: string): void => {
    const command = parseTuiCommand(text);
    if (command) {
      void handleCommand(command);
      return;
    }
    queue.push(text);
    store.setQueued(queue.length);
    void drain();
  };

  const handleCommand = async (command: TuiCommand): Promise<void> => {
    switch (command.kind) {
      case "help":
        store.setNotice(TUI_HELP_LINES);
        return;
      case "exit":
        if (busy) {
          store.setNotice(["当前运行中，先按 Esc 中断后再退出。"]);
          return;
        }
        exitTui?.();
        return;
      case "clear":
        if (busy) {
          store.setNotice(["当前运行中，先按 Esc 中断后再清除会话。"]);
          return;
        }
        try {
          store.reset(await session.clear());
          store.setNotice(["会话已清除。"]);
        } catch (error) {
          store.fail(messageOf(error));
        }
        return;
      case "unknown":
        store.setNotice([`未知命令：/${command.name}`, "输入 /help 查看可用命令。"]);
    }
  };

  const drain = async (): Promise<void> => {
    if (busy) return;
    const text = queue.shift();
    store.setQueued(queue.length);
    if (text === undefined) return;
    busy = true;
    cancelRequested = false;
    store.beginRun();
    let failed = false;
    try {
      const runId = await session.send(text);
      if (cancelRequested) session.cancel();
      await session.wait(runId);
    } catch (error) {
      failed = true;
      queue.length = 0;
      store.setQueued(0);
      store.fail(messageOf(error));
    } finally {
      busy = false;
      cancelRequested = false;
    }
    if (failed || queue.length === 0) {
      store.finishRun();
      return;
    }
    void drain();
  };

  const cancel = (): void => {
    if (!busy) return;
    cancelRequested = true;
    queue.length = 0;
    store.setQueued(0);
    store.markCancelling();
    session.cancel();
  };

  const registerExit = (exit: () => void): void => {
    exitTui = exit;
  };

  const selectionStore = altScreen ? new TuiSelectionStore() : undefined;
  const clipboard = altScreen ? createClipboardWriter(process.stdout) : undefined;
  const selectionActions =
    selectionStore === undefined || clipboard === undefined
      ? undefined
      : createSelectionActions(selectionStore, clipboard);
  const pointer = altScreen ? createPointerInput(process.stdin, process.stdout) : undefined;
  const unsubscribePointer = pointer?.source.subscribe((event) =>
    selectionActions?.handlePointer(event),
  );

  try {
    const instance = render(
      <App
        botName={botName}
        model={model}
        onCancel={cancel}
        onClearSelection={selectionActions?.clear}
        onCopySelection={selectionActions?.copy}
        onExitReady={registerExit}
        onSelectAll={selectionActions?.selectAllAndCopy}
        onSubmit={submit}
        pointerSource={pointer?.source}
        selectionStore={selectionStore}
        store={store}
        workspaceRoot={workspaceRoot}
      />,
      {
        ...(pointer === undefined ? {} : { stdin: pointer.stdin }),
        alternateScreen: altScreen,
        exitOnCtrlC: false,
        incrementalRendering: true,
        kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] },
        maxFps: 30,
        ...(selectionStore === undefined ? {} : { onRender: () => selectionStore.commitFrame() }),
      },
    );
    await instance.waitUntilExit();
  } finally {
    unsubscribePointer?.();
    pointer?.dispose();
  }
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
