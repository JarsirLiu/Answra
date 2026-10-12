import type { WorkspaceFileContent } from "@answra/shared";
import { useEffect, useRef, useState } from "react";

/**
 * pdf 预览：pdfjs-dist 渲染到 canvas（懒加载 worker，首次打开才加载）。
 */
export function PdfPreviewPane({ content }: { content: WorkspaceFileContent }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const canvases: Array<HTMLCanvasElement> = [];
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const workerUrl = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url);
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.toString();
        if (cancelled) return;
        const bytes = base64ToBytes(content.dataBase64);
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        if (cancelled) return;
        host.replaceChildren();
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          if (cancelled) return;
          const page = await doc.getPage(pageNumber);
          const scale = 1.4;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvases.push(canvas);
          host.append(canvas);
          const context = canvas.getContext("2d");
          if (!context) continue;
          await page.render({ canvas, canvasContext: context, viewport }).promise;
        }
        if (!cancelled) setStatus("ready");
      } catch (cause) {
        if (!cancelled) {
          setStatus("error");
          setError(cause instanceof Error ? cause.message : "pdf 解析失败");
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const canvas of canvases) canvas.remove();
    };
  }, [content]);

  return (
    <div className="workspace-preview-pdf-wrap" style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {status === "loading" && <div className="workspace-preview-status">pdf 解析中…</div>}
      {status === "error" && <div className="workspace-preview-status">{error}</div>}
      <div ref={hostRef} className="workspace-preview-pdf" />
    </div>
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
