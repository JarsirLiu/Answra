import type {
  DesktopBridge,
  ImeCandidateAction,
  ImeCandidateSnapshot,
  ImeCandidateUpdate,
  ImeSessionCommand,
  ImeSessionSnapshot,
  ImeState,
  WorkspaceFileContent,
} from "@answra/shared";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImeCandidateWindowApp } from "../src/app/ImeCandidateWindowApp";
import { MarkdownEditorPane } from "../src/components/panels/workspace/MarkdownEditorPane";
import { resetImeInputTargetCoordinatorForTests } from "../src/ime/imeInputTargetCoordinator";

function createBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  const bridge: DesktopBridge = {
    fitContent: vi.fn(),
    close: vi.fn(),
    getWorkspaceRoot: vi.fn(),
    pickWorkspaceRoot: vi.fn(),
    listWorkspaceTree: vi.fn(),
    readWorkspaceFile: vi.fn(),
    writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    createWorkspaceEntry: vi.fn(),
    deleteWorkspaceEntry: vi.fn(),
    onWorkspaceChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
  let state: ImeState = {
    enabled: false,
    inputMode: "chinese",
    composing: false,
    preedit: "",
    candidates: [],
    selectedIndex: 0,
    page: 0,
    hasNextPage: false,
  };
  let owner: ImeSessionSnapshot["owner"];
  let revision = 0;
  const snapshot = (): ImeSessionSnapshot => ({
    phase: owner ? "owned" : "idle",
    ...(owner ? { owner } : {}),
    engine: state,
    revision,
  });
  bridge.imeSessionCommand = async (command: ImeSessionCommand) => {
    let result: unknown;
    if (command.type === "acquireTarget") {
      result = await bridge.imeAcquire?.(command.targetId);
      const lease = result as {
        accepted?: boolean;
        generation?: number;
        targetId?: string;
        state?: ImeState;
      };
      if (lease.accepted && lease.generation !== undefined) {
        state = lease.state ?? state;
        owner = {
          windowId: 1,
          webContentsId: 1,
          targetId: lease.targetId ?? command.targetId,
          generation: lease.generation,
        };
      }
    } else {
      switch (command.type) {
        case "releaseTarget":
          result = await bridge.imeRelease?.(command.generation);
          owner = undefined;
          break;
        case "processKey":
          result = await bridge.imeKey?.(command);
          break;
        case "selectCandidate":
          result = await bridge.imeSelect?.(command.index, command.generation);
          break;
        case "cancelComposition":
          result = await bridge.imeReset?.(command.generation);
          break;
        case "resume":
          result = await bridge.imeConfirmFocus?.(command.targetId, command.generation);
          break;
        case "suspend":
          break;
      }
    }
    const response = result as (ImeState & { accepted?: boolean; state?: ImeState }) | undefined;
    if (response && "state" in response && response.state) state = response.state;
    else if (response && "enabled" in response) state = response;
    revision += 1;
    return {
      commandId: command.commandId,
      accepted: response && "accepted" in response ? response.accepted === true : state.enabled,
      snapshot: snapshot(),
      ...(state.committedText ? { commit: { text: state.committedText, revision } } : {}),
    };
  };
  bridge.getImeSessionSnapshot = async () => snapshot();
  bridge.onImeSessionSnapshot = () => () => undefined;
  return bridge;
}

const sampleContent: WorkspaceFileContent = {
  mediaType: "text/markdown",
  dataBase64: "",
  text: "# 标题\n\n正文第一行。",
};

function renderPane(bridge: DesktopBridge, viewMode: "source" | "preview" = "source") {
  return render(
    <MarkdownEditorPane
      path="错题.md"
      content={sampleContent}
      bridge={bridge}
      viewMode={viewMode}
      onViewModeChange={() => undefined}
      externalVersion={0}
      dir=""
    />,
  );
}

describe("MarkdownEditorPane", () => {
  beforeEach(() => {
    localStorage.clear();
    resetImeInputTargetCoordinatorForTests();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mounts the source editor and shows the file content", async () => {
    renderPane(createBridge());
    // CodeMirror 异步挂载（懒加载 chunk）。
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull(), {
      timeout: 5000,
    });
    expect(document.querySelector(".cm-content")?.textContent).toContain("标题");
    expect(screen.getByRole("tab", { name: "源码" })).toHaveAttribute("aria-selected", "true");
  });

  it("routes CodeMirror text through its own Rime lease and selection adapter", async () => {
    const imeState = {
      enabled: true,
      inputMode: "chinese" as const,
      composing: false,
      preedit: "",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    };
    const imeAcquire = vi.fn().mockResolvedValue({
      accepted: true,
      targetId: "workspace-markdown-editor",
      generation: 12,
      state: imeState,
    });
    const imeKey = vi.fn().mockResolvedValue({ ...imeState, committedText: "问" });
    const bridge = createBridge({
      imeAvailable: true,
      imeAcquire,
      imeRelease: vi.fn().mockResolvedValue({ accepted: true, state: imeState }),
      imeKey,
    });
    renderPane(bridge);
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull(), {
      timeout: 5000,
    });
    const content = document.querySelector(".cm-content") as HTMLElement;
    expect(content).toHaveAttribute("data-embedded-ime-target", "true");
    expect(content).toHaveAttribute("data-ime-policy", "text");
    fireEvent.focus(content);
    await waitFor(() => expect(imeAcquire).toHaveBeenCalledWith("workspace-markdown-editor"));
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
    expect(view).not.toBeNull();
    if (!view) throw new Error("expected CodeMirror EditorView to be mounted");
    view.dispatch({ selection: { anchor: 2, head: 2 } });
    fireEvent.keyDown(content, { key: "n", code: "KeyN" });
    await waitFor(() =>
      expect(imeKey).toHaveBeenCalledWith(expect.objectContaining({ generation: 12 })),
    );
    await waitFor(() => expect(view.state.doc.toString()).toBe("# 问标题\n\n正文第一行。"));
  });

  it("connects CodeMirror selection, candidate presentation, commit, and release cancellation", async () => {
    const idleState: ImeState = {
      enabled: false,
      inputMode: "chinese",
      composing: false,
      preedit: "",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    };
    const composingState: ImeState = {
      ...idleState,
      enabled: true,
      composing: true,
      preedit: "wen",
      candidates: [{ text: "文" }, { text: "问" }],
      hasNextPage: false,
    };
    const committedState: ImeState = {
      ...idleState,
      enabled: true,
      committedText: "问",
    };
    let receiveCandidateAction: ((action: ImeCandidateAction) => void) | undefined;
    let receiveCandidateState: ((snapshot: ImeCandidateSnapshot) => void) | undefined;
    let engineState = idleState;
    const imeAcquire = vi.fn().mockResolvedValue({
      accepted: true,
      targetId: "workspace-markdown-editor",
      generation: 30,
      state: { ...idleState, enabled: true },
    });
    const imeKey = vi.fn(async () => {
      engineState = composingState;
      return composingState;
    });
    const imeSelect = vi.fn(async () => {
      engineState = idleState;
      return committedState;
    });
    const imeRelease = vi.fn(async () => {
      engineState = idleState;
      return { accepted: true, state: idleState };
    });
    const setImeCandidate = vi.fn((update: ImeCandidateUpdate) => {
      if (update.type === "show") {
        receiveCandidateState?.({
          state: engineState,
          targetId: update.targetId,
          generation: update.generation,
        });
      } else if (update.type === "clear") {
        receiveCandidateState?.({
          state: idleState,
          ...(update.targetId ? { targetId: update.targetId } : {}),
          ...(update.generation !== undefined ? { generation: update.generation } : {}),
        });
      }
    });
    const bridge = createBridge({
      imeAvailable: true,
      imeAcquire,
      imeKey,
      imeSelect,
      imeRelease,
      setImeCandidate,
      onImeCandidateAction: (listener) => {
        receiveCandidateAction = listener;
        return () => {
          receiveCandidateAction = undefined;
        };
      },
      onImeCandidateState: (listener) => {
        receiveCandidateState = listener;
        return () => {
          receiveCandidateState = undefined;
        };
      },
      requestImeCandidateState: vi.fn(),
      sendImeCandidateAction: (action) => receiveCandidateAction?.(action),
    });
    const pane = renderPane(bridge);
    render(<ImeCandidateWindowApp bridge={bridge} />);
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull(), {
      timeout: 5000,
    });
    const content = document.querySelector(".cm-content") as HTMLElement;
    fireEvent.focus(content);
    fireEvent.focusIn(content);
    await waitFor(() => expect(imeAcquire).toHaveBeenCalledOnce());
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
    expect(view).not.toBeNull();
    if (!view) throw new Error("expected CodeMirror EditorView to be mounted");
    view.dispatch({ selection: { anchor: 2, head: 4 } });

    fireEvent.keyDown(content, { key: "n", code: "KeyN" });
    await waitFor(() => expect(imeKey).toHaveBeenCalledOnce());
    await waitFor(() => expect(setImeCandidate).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("listbox", { name: "输入法候选词" })).toBeTruthy());
    expect(setImeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "show",
        targetId: "workspace-markdown-editor",
        generation: 30,
      }),
    );
    expect(screen.getByText("wen")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /问/ }));
    await waitFor(() => expect(view.state.doc.toString()).toBe("# 问\n\n正文第一行。"));
    expect(imeSelect).toHaveBeenCalledWith(1, 30);
    expect(view.state.selection.main.head).toBe(3);
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "输入法候选词" })).toBeNull());

    fireEvent.keyDown(content, { key: "n", code: "KeyN" });
    await waitFor(() => expect(screen.getByText("wen")).toBeInTheDocument());
    const textBeforeCancel = view.state.doc.toString();
    const selectionBeforeCancel = view.state.selection.main;
    pane.rerender(
      <MarkdownEditorPane
        path="错题.md"
        content={sampleContent}
        bridge={bridge}
        viewMode="preview"
        onViewModeChange={() => undefined}
        externalVersion={0}
        dir=""
      />,
    );
    await waitFor(() => expect(imeRelease).toHaveBeenCalled());
    expect(view.state.doc.toString()).toBe(textBeforeCancel);
    expect(view.state.selection.main).toEqual(selectionBeforeCancel);
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "输入法候选词" })).toBeNull());
    expect(imeSelect).toHaveBeenCalledOnce();
  });

  it("handles an uncomposed Enter as an editor newline while embedded IME is active", async () => {
    const imeState = {
      enabled: true,
      inputMode: "chinese" as const,
      composing: false,
      preedit: "",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    };
    const imeAcquire = vi.fn().mockResolvedValue({
      accepted: true,
      targetId: "workspace-markdown-editor",
      generation: 13,
      state: imeState,
    });
    const imeKey = vi.fn().mockResolvedValue(imeState);
    const bridge = createBridge({
      imeAvailable: true,
      imeAcquire,
      imeRelease: vi.fn().mockResolvedValue({ accepted: true, state: imeState }),
      imeKey,
    });
    renderPane(bridge);
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
    const content = document.querySelector(".cm-content") as HTMLElement;
    fireEvent.focus(content);
    await waitFor(() => expect(imeAcquire).toHaveBeenCalled());

    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
    expect(view).not.toBeNull();
    if (!view) throw new Error("expected CodeMirror EditorView to be mounted");
    view.dispatch({ selection: { anchor: 0 } });

    fireEvent.keyDown(content, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(view.state.doc.toString()).toBe("\n# 标题\n\n正文第一行。"));
    expect(imeKey).not.toHaveBeenCalled();

    fireEvent.keyDown(content, { key: "Backspace", code: "Backspace" });
    await waitFor(() => expect(view.state.doc.toString()).toBe(sampleContent.text));
  });

  it("renders markdown in preview, including inline HTML via rehype-raw", async () => {
    const text = "# 标题\n\n第一行<br/>第二行 [链接](https://example.com)";
    render(
      <MarkdownEditorPane
        path="错题.md"
        content={{ mediaType: "text/markdown", dataBase64: "", text }}
        bridge={createBridge()}
        viewMode="preview"
        onViewModeChange={() => undefined}
        externalVersion={0}
        dir=""
      />,
    );
    // 预览态需动态加载 react-markdown + rehype-raw 等 chunk，冷加载较慢，
    // 放宽 waitFor 超时避免全量测试时偶发超时。
    await waitFor(
      () => expect(document.querySelector(".workspace-preview-markdown")).not.toBeNull(),
      { timeout: 5000 },
    );
    await waitFor(
      () =>
        expect(document.querySelector(".workspace-preview-markdown h1")?.textContent).toBe("标题"),
      { timeout: 5000 },
    );
    // 内嵌 HTML（<br/>）被 rehype-raw 真正渲染，而不是当作文本显示。
    expect(document.querySelector(".workspace-preview-markdown br")).not.toBeNull();
    expect(document.querySelector(".workspace-preview-markdown a")?.getAttribute("href")).toBe(
      "https://example.com",
    );
  });

  it("silently reloads on external change when there are no unsaved edits", async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValue({ mediaType: "text/markdown", dataBase64: "", text: "外部新内容" });
    const writeWorkspaceFile = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderPane(createBridge({ readWorkspaceFile, writeWorkspaceFile }));
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());

    // 外部变更（干净状态）：应读取新内容，不触发写盘。
    rerender(
      <MarkdownEditorPane
        path="错题.md"
        content={sampleContent}
        bridge={createBridge({ readWorkspaceFile, writeWorkspaceFile })}
        viewMode="source"
        onViewModeChange={() => undefined}
        externalVersion={1}
        dir=""
      />,
    );
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith("错题.md"));
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("flags a conflict on external change while there are unsaved edits", async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValue({ mediaType: "text/markdown", dataBase64: "", text: "外部新内容" });
    const writeWorkspaceFile = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderPane(createBridge({ readWorkspaceFile, writeWorkspaceFile }));
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());

    // 制造未保存编辑：经 CodeMirror 的 EditorView 派发一次插入事务，
    // 触发组件内的 updateListener 置脏（比模拟 DOM 输入更确定）。
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
    expect(view).not.toBeNull();
    if (!view) throw new Error("expected CodeMirror EditorView to be mounted");
    act(() => {
      view.dispatch(view.state.replaceSelection("X"));
    });

    rerender(
      <MarkdownEditorPane
        path="错题.md"
        content={sampleContent}
        bridge={createBridge({ readWorkspaceFile, writeWorkspaceFile })}
        viewMode="source"
        onViewModeChange={() => undefined}
        externalVersion={1}
        dir=""
      />,
    );
    await waitFor(() => expect(screen.getByText(/文件已被外部修改/)).toBeInTheDocument());
    // 冲突时不静默覆盖、不读盘重写。
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
  });
});
