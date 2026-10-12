import { Maximize, Minus, Plus, RotateCcw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

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
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
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
}: ZoomablePreviewProps) {
  const [zoom, setZoom] = useState(initialZoom);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const fitWidth = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const contentWidth = content.scrollWidth;
    const available = viewport.clientWidth;
    if (contentWidth <= 0 || available <= 0) return;
    setZoom(clampZoom(available / contentWidth));
  }, []);

  // 内容就绪（fitSignal 变化）后自动适应一次宽度。
  useEffect(() => {
    if (fitSignal === undefined) return;
    fitWidth();
  }, [fitSignal, fitWidth]);

  return (
    <div className={`zoomable-preview${className ? ` ${className}` : ""}`}>
      <div className="zoomable-preview__toolbar" role="toolbar" aria-label="缩放">
        <button
          type="button"
          aria-label="缩小"
          title="缩小"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((value) => clampZoom(value - ZOOM_STEP))}
        >
          <Minus aria-hidden="true" size={14} />
        </button>
        <button
          type="button"
          className="zoomable-preview__value"
          title="重置为 100%"
          onClick={() => setZoom(initialZoom)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label="放大"
          title="放大"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((value) => clampZoom(value + ZOOM_STEP))}
        >
          <Plus aria-hidden="true" size={14} />
        </button>
        <button type="button" aria-label="适应宽度" title="适应宽度" onClick={fitWidth}>
          <Maximize aria-hidden="true" size={13} />
        </button>
        <button
          type="button"
          aria-label="重置缩放"
          title="重置缩放"
          disabled={zoom === initialZoom}
          onClick={() => setZoom(initialZoom)}
        >
          <RotateCcw aria-hidden="true" size={13} />
        </button>
      </div>
      <div className="zoomable-preview__viewport" ref={viewportRef}>
        <div className="zoomable-preview__content" ref={contentRef} style={{ zoom }}>
          {children}
        </div>
      </div>
    </div>
  );
}
