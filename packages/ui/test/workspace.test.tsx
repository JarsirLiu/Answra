import type { DesktopBridge, WorkspaceNode } from "@answra/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocxPreviewPane } from "../src/components/panels/workspace/DocxPreviewPane";
import {
  classifyFile,
  pasteImageName,
  resolveRelative,
  toResourceUrl,
} from "../src/components/panels/workspace/fileKind";
import { PdfPreviewPane } from "../src/components/panels/workspace/PdfPreviewPane";
import { WorkspacePanel } from "../src/components/panels/workspace/WorkspacePanel";

const { renderDocx, pdfGetDocument } = vi.hoisted(() => ({
  renderDocx: vi.fn(),
  pdfGetDocument: vi.fn(),
}));
vi.mock("docx-preview", () => ({ renderAsync: renderDocx }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.mjs" }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdfGetDocument,
}));

describe("workspace fileKind", () => {
  it("classifies file kinds", () => {
    expect(classifyFile("笔记.md")).toBe("markdown");
    expect(classifyFile("paper.docx")).toBe("docx");
    expect(classifyFile("slides.pdf")).toBe("pdf");
    expect(classifyFile("shot.PNG")).toBe("image");
    expect(classifyFile("data.json")).toBe("text");
    expect(classifyFile("archive.zip")).toBe("other");
  });

  it("resolves relative references against the current document directory", () => {
    expect(resolveRelative("数学", "assets/a.png")).toBe("数学/assets/a.png");
    expect(resolveRelative("", "assets/a.png")).toBe("assets/a.png");
    expect(resolveRelative("数学", "../root.md")).toBe("root.md");
    expect(toResourceUrl("数学/assets/a.png")).toBe(
      "answra-file:///%E6%95%B0%E5%AD%A6/assets/a.png",
    );
  });

  it("generates conflict-free paste image names", () => {
    const first = pasteImageName("png");
    const second = pasteImageName("png");
    expect(first).toMatch(/^\d{14}-[a-z0-9]{4}\.png$/);
    expect(first).not.toBe(second);
  });
});

describe("WorkspacePanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function createBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
    return {
      fitContent: vi.fn(),
      close: vi.fn(),
      getWorkspaceRoot: vi.fn().mockResolvedValue({ root: null }),
      pickWorkspaceRoot: vi.fn().mockResolvedValue({ root: null }),
      listWorkspaceTree: vi.fn().mockResolvedValue([] as WorkspaceNode[]),
      readWorkspaceFile: vi.fn(),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      createWorkspaceEntry: vi.fn().mockResolvedValue(undefined),
      deleteWorkspaceEntry: vi.fn().mockResolvedValue(undefined),
      onWorkspaceChanged: vi.fn(() => () => undefined),
      ...overrides,
    };
  }

  it("shows the directory picker when no root is cached", async () => {
    render(<WorkspacePanel bridge={createBridge()} onClose={() => undefined} />);
    expect(await screen.findByRole("button", { name: /选择目录/ })).toBeInTheDocument();
    expect(screen.getByText(/选择一个本地目录/)).toHaveClass("workspace-panel__empty-copy");
    expect(screen.getByRole("button", { name: /选择目录/ })).toHaveClass(
      "surface-control--primary",
    );
  });

  it("restores the cached root and renders the tree", async () => {
    const tree: WorkspaceNode[] = [
      { name: "数学", path: "数学", kind: "dir" },
      { name: "错题.md", path: "数学/错题.md", kind: "file" },
      { name: "阅读.md", path: "阅读.md", kind: "file" },
    ];
    render(
      <WorkspacePanel
        bridge={createBridge({
          getWorkspaceRoot: vi.fn().mockResolvedValue({ root: "D:/notes" }),
          listWorkspaceTree: vi.fn().mockResolvedValue(tree),
        })}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("D:/notes")).toBeInTheDocument();
    expect((await screen.findAllByText("错题.md")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("阅读.md").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "数学" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "数学" })).toHaveClass("workspace-tree__item");
    expect(screen.getByText("阅读.md").closest(".workspace-tree__row")).toHaveClass(
      "workspace-tree__row",
    );
    expect(screen.getByRole("button", { name: "新建文档" })).toHaveClass("workspace-tree__action");
    expect(screen.getAllByText("错题.md")[0]?.closest("ul")).toHaveClass(
      "workspace-tree__children",
    );
    const collapseButton = screen.getByRole("button", { name: "收起目录" });
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapseButton);
    expect(screen.getByRole("button", { name: "展开目录" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("阅读.md")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "放大预览区域" })).not.toBeInTheDocument();
  });

  it("opens a markdown file through the bridge", async () => {
    const tree: WorkspaceNode[] = [{ name: "错题.md", path: "错题.md", kind: "file" }];
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValue({ mediaType: "text/markdown", dataBase64: "", text: "# 标题" });
    render(
      <WorkspacePanel
        bridge={createBridge({
          getWorkspaceRoot: vi.fn().mockResolvedValue({ root: "D:/notes" }),
          listWorkspaceTree: vi.fn().mockResolvedValue(tree),
          readWorkspaceFile,
        })}
        onClose={() => undefined}
      />,
    );
    fireEventClick(await screen.findByText("错题.md"));
    await waitFor(() => expect(readWorkspaceFile).toHaveBeenCalledWith("错题.md"));
  });

  it("migrates the legacy localStorage note once into the workspace", async () => {
    localStorage.setItem("answra-note", "旧笔记内容");
    const createWorkspaceEntry = vi.fn().mockResolvedValue(undefined);
    const writeWorkspaceFile = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkspacePanel
        bridge={createBridge({
          getWorkspaceRoot: vi.fn().mockResolvedValue({ root: "D:/notes" }),
          createWorkspaceEntry,
          writeWorkspaceFile,
        })}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(createWorkspaceEntry).toHaveBeenCalledWith({ path: "未迁移笔记.md", kind: "file" });
      expect(writeWorkspaceFile).toHaveBeenCalledWith("未迁移笔记.md", "旧笔记内容");
    });
    expect(localStorage.getItem("answra-note-migrated")).toBe("1");
    expect(localStorage.getItem("answra-note")).toBe("旧笔记内容");

    // 迁移标记生效后不再重复迁移。
    createWorkspaceEntry.mockClear();
    render(<WorkspacePanel bridge={createBridge()} onClose={() => undefined} />);
    await waitFor(() => expect(createWorkspaceEntry).not.toHaveBeenCalled());
  });
});

describe("DocxPreviewPane", () => {
  beforeEach(() => {
    renderDocx.mockReset().mockResolvedValue(undefined);
  });

  it("passes document bytes to docx-preview and mounts the preview host only after success", async () => {
    const { container } = render(
      <DocxPreviewPane
        content={{ mediaType: "application/docx", dataBase64: "AQID", text: null }}
      />,
    );
    expect(screen.getByText("docx 解析中…")).toBeInTheDocument();
    expect(container.querySelector(".workspace-preview-docx")).toHaveAttribute("hidden");
    await waitFor(() => expect(renderDocx).toHaveBeenCalled());
    expect(renderDocx.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
    expect(renderDocx.mock.calls[0]?.[0]).toEqual(new Uint8Array([1, 2, 3]));
    await waitFor(() =>
      expect(container.querySelector(".workspace-preview-docx")).not.toHaveAttribute("hidden"),
    );
  });

  it("shows an error without rendering an empty document pane", async () => {
    renderDocx.mockRejectedValueOnce(new Error("无法解析文档"));
    const { container } = render(
      <DocxPreviewPane
        content={{ mediaType: "application/docx", dataBase64: "AQID", text: null }}
      />,
    );
    expect(await screen.findByText("无法解析文档")).toBeInTheDocument();
    expect(container.querySelector(".workspace-preview-docx")).toHaveAttribute("hidden");
  });
});

describe("PdfPreviewPane", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
    pdfGetDocument.mockReset().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn().mockResolvedValue({
          getViewport: vi.fn(({ scale }: { scale: number }) => ({
            width: 200 * scale,
            height: 300 * scale,
          })),
          render: vi.fn().mockReturnValue({ promise: Promise.resolve() }),
        }),
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads PDF bytes and reveals the canvas host after rendering", async () => {
    const { container } = render(
      <PdfPreviewPane
        content={{ mediaType: "application/pdf", dataBase64: "JVBERi0xLjc=", text: null }}
      />,
    );
    expect(screen.getByText("PDF 解析中…")).toBeInTheDocument();
    await waitFor(() => expect(pdfGetDocument).toHaveBeenCalledTimes(1));
    expect(pdfGetDocument).toHaveBeenCalledWith({
      data: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]),
    });
    await waitFor(() =>
      expect(container.querySelector(".workspace-preview-pdf")).not.toHaveAttribute("hidden"),
    );
    fireEvent.click(screen.getByRole("button", { name: "放大 PDF" }));
    expect(await screen.findByText("110%")).toBeInTheDocument();
    // 缩放只改画布显示尺寸（CSS），不重新解析或重渲染文档，故 getDocument 仅调用一次。
    expect(pdfGetDocument).toHaveBeenCalledTimes(1);
    const canvas = container.querySelector(
      ".workspace-preview-pdf canvas",
    ) as HTMLCanvasElement | null;
    expect(canvas).not.toBeNull();
    expect(canvas?.style.width).toBe("220px");
    expect(canvas?.style.height).toBe("330px");
  });

  it("shows PDF load failures without exposing an empty canvas host", async () => {
    pdfGetDocument.mockReturnValueOnce({
      promise: Promise.reject(new Error("PDF 数据无效")),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(
      <PdfPreviewPane
        content={{ mediaType: "application/pdf", dataBase64: "JVBERi0xLjc=", text: null }}
      />,
    );
    expect(await screen.findByText(/PDF 数据无效.*阶段：loading document/)).toBeInTheDocument();
    expect(container.querySelector(".workspace-preview-pdf")).toHaveAttribute("hidden");
  });

  it("shows a useful message when the file bytes do not have a PDF header", async () => {
    render(
      <PdfPreviewPane content={{ mediaType: "application/pdf", dataBase64: "AQID", text: null }} />,
    );
    expect(
      await screen.findByText(/文件内容不是有效的 PDF（缺少 %PDF- 文件头）/),
    ).toBeInTheDocument();
    expect(pdfGetDocument).not.toHaveBeenCalled();
  });
});

function fireEventClick(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}
