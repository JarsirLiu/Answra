import type { DesktopBridge, WorkspaceNode } from "@answra/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyFile,
  pasteImageName,
  resolveRelative,
  toResourceUrl,
} from "../src/components/panels/workspace/fileKind";
import { WorkspacePanel } from "../src/components/panels/workspace/WorkspacePanel";

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

function fireEventClick(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}
