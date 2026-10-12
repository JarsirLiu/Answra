import { Camera, Send, Square, X } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import { ICON, ICON_SM, ICON_STROKE } from "../../tokens";
import { SurfaceButton } from "../controls/SurfaceButton";
import type { ChatAttachment } from "./ChatPanel";
import "./ReplyBar.css";

/** 回复条两种形态：编辑预备区（composing）/ 流式滚动回复（streaming）。 */
export type ReplyPhase = "composing" | "streaming";

/** 跑马灯恒定滚动速度（px/s）：按时长线性跟读的舒适区，回复长短不再影响快慢。 */
const TICKER_SPEED = 75;
/** 循环一圈后重新入场前的空档（px）：固定小间距，不再随容器宽度拉长等待。 */
const TICKER_GAP = 48;

interface ReplyBarProps {
  /** 当前形态。 */
  phase: ReplyPhase;
  /** 本轮预备发送的多张截图。 */
  attachments: ChatAttachment[];
  draft: string;
  /** 流式展示中的 AI 回复文本（streaming 态）。 */
  replyText: string;
  replyError?: string;
  replyPending?: boolean;
  /** 隐藏的文件选择框 ref（无捕获桥时回落选择本地图片）。 */
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** 从文件选择框追加一张本地图片。 */
  onAttachmentChange: (file: File | null) => void;
  /** 移除某张预备截图（按 id）。 */
  onAttachmentRemove: (id: string) => void;
  /** 在原地回复条内继续追加一次截图。 */
  onScreenshot: () => void;
  /** 确认发送：进入流式态。 */
  onSend: () => void;
  /** 收起回复条（放弃本轮，或结束流式展示）。 */
  onClose: () => void;
  /** 取消当前回复，回到同一条回复条的发送态。 */
  onCancel: () => void;
}

/**
 * 横条式回复条：编辑态 = 截图缩略条 + 图标操作组（条内不设输入框，隐身模式
 * 下打字经输入法候选窗会被捕获暴露）；点发送后左侧整体变成匀速滚动的跑马灯
 * 输出 AI 回复，发送键原位切换为可点击取消的“进行中”停止键，取消后回到
 * 发送态；不打开、不复用对话面板。
 */
export function ReplyBar({
  phase,
  attachments,
  draft,
  replyText,
  replyError,
  replyPending,
  fileInputRef,
  onAttachmentChange,
  onAttachmentRemove,
  onScreenshot,
  onSend,
  onClose,
  onCancel,
}: ReplyBarProps) {
  const tickerTextRef = useRef<HTMLSpanElement>(null);
  // 滚动偏移放在 ref 里跨 effect 保留：流式文本每帧变长时位置无缝续走，
  // 不会像改 animationDuration 那样按时间比例重算进度而肉眼跳变。
  const tickerXRef = useRef(0);

  // 恒速跑马灯：rAF 每帧按 TICKER_SPEED px/s 平移 transform，文本增长只改
  // 位移终点，不改当前位置。宽度变化交给 ResizeObserver 重测（transform
  // 不参与布局，不会自触发）。不用 setState，避免每次 delta 额外重渲染
  // （回复窗口按渲染上报尺寸，多余渲染会造成重复 fitContent）。
  useEffect(() => {
    const element = tickerTextRef.current;
    const ticker = element?.parentElement;
    if (!element || !ticker || phase !== "streaming") return;

    let textWidth = 0;
    let containerWidth = ticker.clientWidth;
    let overflowing = false;

    const measure = () => {
      containerWidth = ticker.clientWidth;
      textWidth = element.offsetWidth;
      const wasOverflowing = overflowing;
      overflowing = textWidth > containerWidth;
      if (overflowing && !wasOverflowing) {
        // 文本刚超出容器：从右端入场，起点与既有滚动衔接。
        tickerXRef.current = containerWidth;
      } else if (!overflowing) {
        // 未超出则原位静止，等流式增量把它撑宽。
        tickerXRef.current = 0;
        element.style.transform = "";
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(ticker);

    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (overflowing) {
        tickerXRef.current -= TICKER_SPEED * dt;
        if (tickerXRef.current < -(textWidth + TICKER_GAP)) {
          tickerXRef.current = containerWidth;
        }
        element.style.transform = `translateX(${tickerXRef.current}px)`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      element.style.transform = "";
    };
  }, [phase]);

  if (phase === "streaming") {
    return (
      <section aria-live="polite" className="reply-bar reply-bar--stream floating-surface">
        <div className="ticker">
          <span className="ticker-text" ref={tickerTextRef}>
            {replyError || (replyPending ? replyText || "正在等待模型回复…" : replyText || "模型未返回文本回复")}
          </span>
        </div>
        {/* 原发送键的位置切换为“进行中”停止键，点击取消并回退到发送态。 */}
        <SurfaceButton
          aria-label="取消回复并返回发送"
          className="reply-stop"
          onClick={replyPending || replyError ? onCancel : onClose}
          type="button"
          variant="primary"
        >
          {replyPending ? (
            <Square aria-hidden="true" fill="currentColor" size={ICON_SM} strokeWidth={ICON_STROKE} />
          ) : (
            <Send aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
          )}
        </SurfaceButton>
        <SurfaceButton aria-label="收起回复条" className="reply-close" onClick={onClose}>
          <X aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
        </SurfaceButton>
      </section>
    );
  }

  return (
    <section className="reply-bar reply-bar--compose floating-surface">
      <input
        accept="image/*"
        aria-label="选择截图图片"
        className="file-input-hidden"
        onChange={(event) => {
          onAttachmentChange(event.target.files?.[0] ?? null);
          event.target.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
      {attachments.length > 0 && (
        <fieldset className="attachment-strip" aria-label="待发送截图">
          {attachments.map((att) => (
            <div className="attachment-thumb" key={att.id}>
              {/* 回复条是受保护的独立窗口，缩略图只在本地窗口绘制，不进入系统采集。 */}
              <img
                alt={att.name || "截图缩略图"}
                className="attachment-thumb-image"
                src={att.previewUrl}
              />
              <SurfaceButton
                aria-label="移除截图"
                className="attachment-remove"
                onClick={() => onAttachmentRemove(att.id)}
              >
                <X aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
              </SurfaceButton>
            </div>
          ))}
        </fieldset>
      )}
      {replyError && <span className="reply-error" role="alert">{replyError}</span>}
      <div className="reply-actions">
        <SurfaceButton aria-label="继续截图" onClick={onScreenshot}>
          <Camera aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
        </SurfaceButton>
        <SurfaceButton
          aria-label="确认发送"
          className="reply-send"
          disabled={!draft.trim() && attachments.length === 0}
          onClick={onSend}
          variant="primary"
        >
          <Send aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
        </SurfaceButton>
        <SurfaceButton aria-label="收起回复条" className="reply-close" onClick={onClose}>
          <X aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
        </SurfaceButton>
      </div>
    </section>
  );
}
