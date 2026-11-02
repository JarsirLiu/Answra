import type { DesktopBridge, MarkdownDocument } from "@answra/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownWindowApp } from "../src/app/markdown";
// 预热懒加载 Markdown 运行时，避免并发全量测试时动态 import 排队超过断言等待窗口。
import "../src/components/markdown/MarkdownRuntime";

const document: MarkdownDocument = {
  path: "C:/Notes/meeting notes.md",
  name: "meeting notes.md",
  text: "# Meeting notes",
  mediaType: "text/markdown",
};

function createBridge(text = document.text): DesktopBridge {
  return {
    fitContent: vi.fn(),
    close: vi.fn(),
    markdownGetDocument: vi.fn().mockResolvedValue({ ...document, text }),
    markdownSaveDocument: vi.fn().mockResolvedValue(undefined),
    markdownOpenDocument: vi.fn().mockResolvedValue(null),
    markdownResolveImage: vi.fn().mockResolvedValue("data:image/png;base64,aGVsbG8="),
    onMarkdownChanged: vi.fn().mockReturnValue(vi.fn()),
  };
}

describe("MarkdownWindowApp", () => {
  it("loads and saves the bound document without accepting a renderer path", async () => {
    const bridge = createBridge();
    render(<MarkdownWindowApp bridge={bridge} />);

    expect(await screen.findByText("meeting notes.md")).toBeTruthy();
    expect(screen.getByTitle("C:/Notes/meeting notes.md")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("已保存");
    fireEvent.click(screen.getByRole("button", { name: "保存 Markdown 文件" }));

    await waitFor(() =>
      expect(bridge.markdownSaveDocument).toHaveBeenCalledWith("# Meeting notes"),
    );
  });

  it("opens another document through the restricted desktop bridge", async () => {
    const bridge = createBridge();
    render(<MarkdownWindowApp bridge={bridge} />);

    fireEvent.click(await screen.findByRole("button", { name: "打开 Markdown 文件" }));

    expect(bridge.markdownOpenDocument).toHaveBeenCalledOnce();
  });

  it("renders a local Markdown image resolved by the desktop bridge", async () => {
    const resolveImage = vi.fn().mockResolvedValue("data:image/png;base64,aGVsbG8=");
    const bridge = {
      ...createBridge("![cover](images/cover.png)"),
      markdownResolveImage: resolveImage,
    };
    render(<MarkdownWindowApp bridge={bridge} />);

    const modeToolbar = await screen.findByRole("toolbar", { name: "编辑模式" });
    fireEvent.click(within(modeToolbar).getByRole("button", { name: /预览/ }));

    const image = await screen.findByAltText("cover", {}, { timeout: 10_000 });
    expect(resolveImage).toHaveBeenCalledWith("images/cover.png");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
  }, 20_000);

  it("shows a useful message when a local Markdown image cannot be resolved", async () => {
    const resolveImage = vi.fn().mockRejectedValue(new Error("missing"));
    const bridge = {
      ...createBridge("![cover](images/missing.png)"),
      markdownResolveImage: resolveImage,
    };
    render(<MarkdownWindowApp bridge={bridge} />);

    const modeToolbar = await screen.findByRole("toolbar", { name: "编辑模式" });
    fireEvent.click(within(modeToolbar).getByRole("button", { name: /预览/ }));

    expect(await screen.findByText("cover：图片无法显示")).toBeTruthy();
  });
});
