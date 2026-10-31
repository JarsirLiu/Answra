import { Maximize, Minus, Plus, RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Tooltip } from "../../controls/Tooltip";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;

interface ZoomablePreviewProps {
  children: ReactNode;
  className?: string;
  /** 初始缩放比例，1 = 100%。 */
  initialZoom?: number;
  /** 该值变化时自动适应宽度（用于内容异步就绪后重新适应，如 docx/pdf 渲染完成）。 */
  fitSignal?: unknown;
  /**
   * 内容自然宽度（CSS px），由调用方提供权威值（pdf.js 页面宽度、图片原始宽度、
   * docx 页面宽度）。适配必须用它：渲染尺寸随 zoom 变化，量取会漂移，
   * 反复适应会让页面越缩越小、四周缝隙越来越大。
   */
  fitWidthPx?: number;
}

function clampZoom(value: number): number {
  // 向下取整到 1%：适配时页面宽度不会因四舍五入超出可用宽度而引出横向滚动条。
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.floor(value * 100) / 100));
}

/**
 * 统一预览缩放容器：工具栏 + CSS `zoom`，网页式缩放，不重读/不重渲染内容。
 *
 * 子内容始终以 100% 自然尺寸渲染，缩放由外层 `zoom` 承担，因此切换文件或调整
 * 缩放都不会重建内部 DOM。所有预览类型（docx/pdf/txt/md/图片）共用本容器。
 */
export function ZoomablePreview({
  children,
  className,
  initialZoom = 1,
  fitSignal,
  fitWidthPx,
}: ZoomablePreviewProps) {
  const [zoom, setZoom] = useState(initialZoom);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // 适应模式：视口尺寸变化时自动重适应；任何手动缩放都退出该模式，
  // 直到再次点「适应宽度」（或换文件触发 fitSignal）才恢复跟随。
  const autoFitRef = useRef(true);

  const fitWidth = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const available = viewport.clientWidth;
    if (available <= 0) return;
    // 没有权威自然宽度（文本/markdown 等自动折行内容）：适应宽度即 100%。
    if (!fitWidthPx || fitWidthPx <= 0) {
      setZoom(clampZoom(initialZoom));
      return;
    }
    setZoom(clampZoom(available / fitWidthPx));
  }, [fitWidthPx, initialZoom]);

  // 内容就绪（fitSignal 变化）后回到适应模式并适应一次宽度。
  useEffect(() => {
    if (fitSignal === undefined) return;
    autoFitRef.current = true;
    fitWidth();
  }, [fitSignal, fitWidth]);

  // 视口宽度变化（收起/展开目录、面板宽度变化）时跟随重适应，把空间让给正文。
  // 只看宽度：缩放会改变内容高度并引发高度变化，跟随高度会形成自激循环（闪烁）。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let lastWidth = viewport.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = viewport.clientWidth;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      if (autoFitRef.current) fitWidth();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitWidth]);

  const zoomManually = useCallback((next: number) => {
    autoFitRef.current = false;
    setZoom(next);
  }, []);

  const refit = useCallback(() => {
    autoFitRef.current = true;
    fitWidth();
  }, [fitWidth]);

  return (
    <div className={`zoomable-preview${className ? ` ${className}` : ""}`}>
      <div className="zoomable-preview__toolbar" role="toolbar" aria-label="缩放">
        <Tooltip label="缩小">
          <button
            type="button"
            aria-label="缩小"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomManually(clampZoom(zoom - ZOOM_STEP))}
          >
            <Minus aria-hidden="true" size={14} />
          </button>
        </Tooltip>
        <Tooltip label="重置为 100%">
          <button
            type="button"
            className="zoomable-preview__value"
            onClick={() => zoomManually(initialZoom)}
          >
            {Math.round(zoom * 100)}%
          </button>
        </Tooltip>
        <Tooltip label="放大">
          <button
            type="button"
            aria-label="放大"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomManually(clampZoom(zoom + ZOOM_STEP))}
          >
            <Plus aria-hidden="true" size={14} />
          </button>
        </Tooltip>
        <Tooltip label="适应宽度">
          <button type="button" aria-label="适应宽度" onClick={refit}>
            <Maximize aria-hidden="true" size={13} />
          </button>
        </Tooltip>
        <Tooltip label="重置缩放">
          <button
            type="button"
            aria-label="重置缩放"
            disabled={zoom === initialZoom}
            onClick={() => zoomManually(initialZoom)}
          >
            <RotateCcw aria-hidden="true" size={13} />
          </button>
        </Tooltip>
      </div>
      <div className="zoomable-preview__viewport" ref={viewportRef}>
        <div className="zoomable-preview__content" ref={contentRef} style={{ zoom }}>
          {children}
        </div>
      </div>
    </div>
  );
}
