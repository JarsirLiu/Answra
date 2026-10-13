import type { DesktopBridge, WorkspaceFileContent } from "@answra/shared";
import { EditorView } from "@codemirror/view";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditorPane } from "../src/components/panels/workspace/MarkdownEditorPane";

function createBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
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
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("mounts the source editor and shows the file content", async () => {
    renderPane(createBridge());
    // CodeMirror 异步挂载（懒加载 chunk）。
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
    expect(document.querySelector(".cm-content")?.textContent).toContain("标题");
    expect(screen.getByRole("tab", { name: "源码" })).toHaveAttribute("aria-selected", "true");
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
