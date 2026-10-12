import type { WorkspaceFileContent } from "@answra/shared";
import { Minus, Plus, RotateCcw } from "lucide-react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

/**
 * pdf 预览：pdfjs-dist 渲染到 canvas（懒加载 worker，首次打开才加载）。
 *
 * 走 pdf.js 标准路径：只设置 GlobalWorkerOptions.workerSrc，由 pdf.js 自行创建
 * worker、处理 file:// 跨源包装（_createCDNWrapper）并在 worker 失败时降级主线程
 * 解析（fake worker）。禁止手工 new Worker + PDFWorker.fromPort/create({ port })——
 * 该自定义管道在 Electron 29 的 renderer 中会导致 GetDocRequest 握手静默挂起。
 *
 * 缩放通过 CSS 改变画布显示尺寸，不重新解析或重渲染文档（类似网页缩放体验）。
 */
export function PdfPreviewPane({
  content,
  path = "(unknown)",
}: {
  content: WorkspaceFileContent;
  path?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<Array<{ canvas: HTMLCanvasElement; width: number; height: number }>>([]);
  const zoomRef = useRef(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  zoomRef.current = zoom;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let timedOut = false;
    let failed = false;
    let destroyLoadingTask: (() => Promise<void>) | null = null;
    let disposePromise: Promise<void> | null = null;
    let stage = "loading pdfjs";
    pagesRef.current = [];
    const timeout = window.setTimeout(() => {
      if (!cancelled) {
        timedOut = true;
        setStatus("error");
        setError(`${path}: PDF 解析在${stage}阶段超时`);
        void dispose();
      }
    }, 30_000);
    setStatus("loading");
    setError(null);
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const workerEntryUrl = new URL(workerUrl, window.location.href).href;
        pdfjs.GlobalWorkerOptions.workerSrc = workerEntryUrl;
        const bytes = base64ToBytes(content.dataBase64);
        stage = "validating bytes";
        if (cancelled) return;
        const header = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024)));
        if (!header.includes("%PDF-")) {
          throw new Error("文件内容不是有效的 PDF（缺少 %PDF- 文件头）");
        }
        stage = "loading document";
        const loadingTask = pdfjs.getDocument({ data: bytes });
        destroyLoadingTask = () => loadingTask.destroy();
        const doc = await loadingTask.promise;
        if (cancelled) return;
        stage = "rendering pages";
        host.replaceChildren();
        const pixelRatio = window.devicePixelRatio || 1;
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          if (cancelled) return;
          stage = `rendering page ${pageNumber}/${doc.numPages}`;
          const page = await doc.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * pixelRatio);
          canvas.height = Math.floor(viewport.height * pixelRatio);
          canvas.style.width = `${Math.round(viewport.width * zoomRef.current)}px`;
          canvas.style.height = `${Math.round(viewport.height * zoomRef.current)}px`;
          host.append(canvas);
          pagesRef.current.push({ canvas, width: viewport.width, height: viewport.height });
          const context = canvas.getContext("2d");
          if (!context) throw new Error("浏览器无法创建 PDF 画布，请检查 renderer 控制台");
          await page.render({
            canvasContext: context,
            viewport: page.getViewport({ scale: pixelRatio }),
          }).promise;
          if (pageNumber === 1) {
            window.clearTimeout(timeout);
            setStatus("ready");
          }
        }
        if (!cancelled) {
          window.clearTimeout(timeout);
          setStatus("ready");
        }
      } catch (cause) {
        if (!cancelled && !timedOut && !failed) {
          window.clearTimeout(timeout);
          failed = true;
          setStatus("error");
          const message = cause instanceof Error ? cause.message : String(cause);
          setError(`${path}: ${message}（阶段：${stage}）`);
          void dispose();
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      void dispose();
      for (const page of pagesRef.current) page.canvas.remove();
    };

    function dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        if (destroyLoadingTask) await destroyLoadingTask().catch(() => undefined);
      })();
      return disposePromise;
    }
  }, [content, path]);

  // 缩放只改变画布显示尺寸（CSS），不重新解析或重渲染文档，类似网页缩放体验。
  useEffect(() => {
    for (const page of pagesRef.current) {
      page.canvas.style.width = `${Math.round(page.width * zoom)}px`;
      page.canvas.style.height = `${Math.round(page.height * zoom)}px`;
    }
  }, [zoom]);

  return (
    <div className="workspace-preview-pdf-state">
      <div className="workspace-pdf-toolbar" role="toolbar" aria-label="PDF 缩放">
        <button
          type="button"
          aria-label="缩小 PDF"
          title="缩小 PDF"
          disabled={zoom <= MIN_ZOOM}
          onClick={() =>
            setZoom((value) => Math.max(MIN_ZOOM, Math.round((value - ZOOM_STEP) * 10) / 10))
          }
        >
          <Minus aria-hidden="true" size={14} />
        </button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="放大 PDF"
          title="放大 PDF"
          disabled={zoom >= MAX_ZOOM}
          onClick={() =>
            setZoom((value) => Math.min(MAX_ZOOM, Math.round((value + ZOOM_STEP) * 10) / 10))
          }
        >
          <Plus aria-hidden="true" size={14} />
        </button>
        <button
          type="button"
          aria-label="重置 PDF 缩放"
          title="重置缩放"
          disabled={zoom === 1}
          onClick={() => setZoom(1)}
        >
          <RotateCcw aria-hidden="true" size={13} />
        </button>
      </div>
      {status === "loading" && <div className="workspace-preview-status">PDF 解析中…</div>}
      {status === "error" && <div className="workspace-preview-status">{error}</div>}
      <div ref={hostRef} className="workspace-preview-pdf" hidden={status !== "ready"} />
    </div>
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
