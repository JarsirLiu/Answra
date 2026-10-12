import type { WorkspaceFileContent } from "@answra/shared";
import { Minus, Plus, RotateCcw } from "lucide-react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { createPdfWorkerBootstrap, ensurePromiseTry } from "./pdfPromiseCompat";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

/**
 * pdf 预览：pdfjs-dist 渲染到 canvas（懒加载 worker，首次打开才加载）。
 */
export function PdfPreviewPane({
  content,
  path = "(unknown)",
}: {
  content: WorkspaceFileContent;
  path?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let timedOut = false;
    let failed = false;
    const canvases: Array<HTMLCanvasElement> = [];
    let worker: Worker | null = null;
    let workerBlobUrl: string | null = null;
    let pdfWorker: import("pdfjs-dist").PDFWorker | null = null;
    let destroyLoadingTask: (() => Promise<void>) | null = null;
    let disposePromise: Promise<void> | null = null;
    let stage = "loading pdfjs";
    console.info(
      "[workspace][pdf] open",
      JSON.stringify({ path, base64Length: content.dataBase64.length, zoom }),
    );
    const timeout = window.setTimeout(() => {
      if (!cancelled) {
        timedOut = true;
        console.error(
          "[workspace][pdf] timeout",
          JSON.stringify({ path, stage, timeoutMs: 30_000 }),
        );
        setStatus("error");
        setError(`PDF 在${stage}阶段超时，请检查启动终端中的 [workspace][pdf] 日志`);
        void dispose();
      }
    }, 30_000);
    setStatus("loading");
    setError(null);
    void (async () => {
      try {
        const needsPromiseTryPolyfill = ensurePromiseTry();
        const pdfjs = await import("pdfjs-dist");
        const workerEntryUrl = new URL(workerUrl, window.location.href).href;
        pdfjs.GlobalWorkerOptions.workerSrc = workerEntryUrl;
        const bytes = base64ToBytes(content.dataBase64);
        stage = "validating bytes";
        console.info(
          "[workspace][pdf] worker-config",
          JSON.stringify({
            path,
            workerUrl: workerEntryUrl,
            bytes: bytes.length,
          }),
        );
        if (cancelled) return;
        const header = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024)));
        if (!header.includes("%PDF-")) {
          throw new Error("文件内容不是有效的 PDF（缺少 %PDF- 文件头）");
        }
        let workerScriptUrl = workerEntryUrl;
        if (
          window.location.origin === "null" ||
          new URL(workerEntryUrl).origin !== window.location.origin ||
          needsPromiseTryPolyfill
        ) {
          workerBlobUrl = URL.createObjectURL(
            new Blob([createPdfWorkerBootstrap(workerEntryUrl)], {
              type: "text/javascript",
            }),
          );
          workerScriptUrl = workerBlobUrl;
        }
        stage = "starting PDF worker";
        worker = new Worker(workerScriptUrl, { type: "module" });
        const onWorkerError = (event: ErrorEvent) => {
          event.preventDefault();
          if (cancelled || timedOut || failed) return;
          failed = true;
          const message = event.message || event.error?.message || "PDF worker 加载失败";
          console.error(
            "[workspace][pdf] worker-error",
            JSON.stringify({
              path,
              stage,
              message,
              filename: event.filename,
              line: event.lineno,
              column: event.colno,
              stack: event.error instanceof Error ? event.error.stack : null,
            }),
          );
          setStatus("error");
          setError(`${message}（阶段：${stage}；详见启动终端 [workspace][pdf] 日志）`);
          void dispose();
        };
        worker.addEventListener("error", onWorkerError);
        console.info(
          "[workspace][pdf] worker-created",
          JSON.stringify({ path, workerUrl: workerScriptUrl, wrapped: workerBlobUrl !== null }),
        );
        pdfWorker = pdfjs.PDFWorker.create({ port: worker });
        if (cancelled) return;
        stage = "loading document";
        console.info(
          "[workspace][pdf] document-start",
          JSON.stringify({ path, bytes: bytes.length }),
        );
        const loadingTask = pdfjs.getDocument({ data: bytes, worker: pdfWorker });
        destroyLoadingTask = () => loadingTask.destroy();
        loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
          console.info(
            "[workspace][pdf] progress",
            JSON.stringify({ path, loaded, total: total || null }),
          );
        };
        const doc = await loadingTask.promise;
        worker.removeEventListener("error", onWorkerError);
        if (cancelled) return;
        stage = "rendering pages";
        console.info(
          "[workspace][pdf] document-ready",
          JSON.stringify({ path, pages: doc.numPages }),
        );
        host.replaceChildren();
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          if (cancelled) return;
          stage = `rendering page ${pageNumber}/${doc.numPages}`;
          console.info("[workspace][pdf] page-start", JSON.stringify({ path, page: pageNumber }));
          const page = await doc.getPage(pageNumber);
          const viewport = page.getViewport({ scale: zoom });
          const pixelRatio = window.devicePixelRatio || 1;
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * pixelRatio);
          canvas.height = Math.floor(viewport.height * pixelRatio);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          canvases.push(canvas);
          host.append(canvas);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("浏览器无法创建 PDF 画布，请检查 renderer 控制台");
          await page.render({
            canvas,
            canvasContext: context,
            viewport: page.getViewport({ scale: zoom * pixelRatio }),
          }).promise;
          console.info("[workspace][pdf] page-ready", JSON.stringify({ path, page: pageNumber }));
          if (pageNumber === 1) {
            window.clearTimeout(timeout);
            setStatus("ready");
          }
        }
        if (!cancelled) {
          window.clearTimeout(timeout);
          setStatus("ready");
          console.info("[workspace][pdf] complete", JSON.stringify({ path, pages: doc.numPages }));
        }
      } catch (cause) {
        if (!cancelled && !timedOut && !failed) {
          window.clearTimeout(timeout);
          failed = true;
          setStatus("error");
          const message = cause instanceof Error ? cause.message : String(cause);
          console.error(
            "[workspace][pdf] failed",
            JSON.stringify({
              path,
              stage,
              message,
              stack: cause instanceof Error ? cause.stack : null,
            }),
          );
          setError(`${message}（阶段：${stage}；详见启动终端 [workspace][pdf] 日志）`);
          void dispose();
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      void dispose();
      for (const canvas of canvases) canvas.remove();
    };

    function dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        if (destroyLoadingTask) await destroyLoadingTask().catch(() => undefined);
        await pdfWorker?.destroy();
        worker?.terminate();
        if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl);
      })();
      return disposePromise;
    }
  }, [content, path, zoom]);

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
