import type { WorkspaceFileContent } from "@answra/shared";
import { useEffect, useRef, useState } from "react";

/**
 * docx 预览：docx-preview 在渲染进程把文档字节渲染为 HTML。
 * 与 Codex 桌面版同款技术路线（纯前端解析，不依赖 Office）。
 */
export function DocxPreviewPane({ content }: { content: WorkspaceFileContent }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        const bytes = base64ToBytes(content.dataBase64);
        host.replaceChildren();
        await renderAsync(bytes, host, host, {
          inWrapper: true,
          ignoreWidth: false,
          experimental: true,
          useBase64URL: true,
        });
        if (cancelled) return;
        const fitPage = () => {
          const page = host.querySelector<HTMLElement>(".docx");
          if (!page || host.clientWidth === 0) return;
          host.style.zoom = "1";
          const pageWidth = page.offsetWidth;
          if (pageWidth > 0) host.style.zoom = `${Math.min(1, host.clientWidth / pageWidth)}`;
        };
        fitPage();
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(fitPage);
          resizeObserver.observe(host);
        }
        setStatus("ready");
      } catch (cause) {
        if (!cancelled) {
          setStatus("error");
          setError(cause instanceof Error ? cause.message : "docx 解析失败");
        }
      }
    })();
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
    };
  }, [content]);

  return (
    <div className="workspace-preview-docx-state">
      {status === "loading" && <div className="workspace-preview-status">docx 解析中…</div>}
      {status === "error" && <div className="workspace-preview-status">{error}</div>}
      <div ref={hostRef} className="workspace-preview-docx" hidden={status !== "ready"} />
    </div>
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
