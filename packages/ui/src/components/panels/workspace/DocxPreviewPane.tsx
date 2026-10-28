import type { WorkspaceFileContent } from "@answra/shared";
import { useEffect, useRef, useState } from "react";
import { ZoomablePreview } from "./ZoomablePreview";

/**
 * docx 预览：docx-preview 在渲染进程把文档字节渲染为 HTML。
 * 与 Codex 桌面版同款技术路线（纯前端解析，不依赖 Office）。
 *
 * 缩放由外层 `ZoomablePreview` 承担（网页式，不重渲染）；内容就绪后自动适应宽度。
 * 旧版 .doc（OLE2 二进制）docx-preview 无法解析，给出明确提示而非崩溃。
 */
export function DocxPreviewPane({
  content,
  name,
}: {
  content: WorkspaceFileContent;
  name?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  // 页面自然宽度：docx-preview 把页面尺寸写成 `.docx` 的内联 width，直接取用。
  const [pageWidth, setPageWidth] = useState<number | undefined>(undefined);

  const isLegacyDoc =
    !!name && name.toLowerCase().endsWith(".doc") && !name.toLowerCase().endsWith(".docx");

  useEffect(() => {
    if (isLegacyDoc) return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        const bytes = base64ToBytes(content.dataBase64);
        host.replaceChildren();
        setPageWidth(undefined);
        await renderAsync(bytes, host, host, {
          inWrapper: true,
          ignoreWidth: false,
          experimental: true,
          useBase64URL: true,
        });
        const page = host.querySelector<HTMLElement>(".docx");
        const width = page ? Number.parseFloat(page.style.width) : Number.NaN;
        if (!cancelled) setPageWidth(Number.isFinite(width) ? width : undefined);
        if (!cancelled) setStatus("ready");
      } catch (cause) {
        if (!cancelled) {
          setStatus("error");
          setError(cause instanceof Error ? cause.message : "docx 解析失败");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, isLegacyDoc]);

  if (isLegacyDoc) {
    return (
      <div className="workspace-preview-placeholder">
        旧版 .doc 格式暂不支持应用内预览，请在 Word 中另存为 .docx 后重试。
      </div>
    );
  }

  return (
    <ZoomablePreview
      className="workspace-preview-docx-zoom"
      fitSignal={status === "ready" ? 1 : 0}
      fitWidthPx={pageWidth}
    >
      {status === "loading" && <div className="workspace-preview-status">docx 解析中…</div>}
      {status === "error" && <div className="workspace-preview-status">{error}</div>}
      <div ref={hostRef} className="workspace-preview-docx" hidden={status !== "ready"} />
    </ZoomablePreview>
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
