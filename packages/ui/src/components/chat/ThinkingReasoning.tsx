import { useLayoutEffect, useRef, useState } from "react";
import styles from "./ThinkingReasoning.module.css";

/** 视口最大高度（与 CSS 保持同步）：内容超出后封顶滚动。 */
const MAX_H = 180;
/** 封顶后上下软遮罩的高度。 */
const FADE = 16;

interface ThinkingReasoningProps {
  /** 模型思维链文本（流式更新）。 */
  reasoning: string;
  /** 思考阶段：思维链仍在流出且回答正文未开始。 */
  thinking: boolean;
  /** 思考耗时（毫秒）；未记录时省略时长。 */
  durationMs?: number;
}

/** 按中英文句读与换行切句，逐句显现。 */
function toSentences(reasoning: string): string[] {
  return reasoning
    .split(/\n+|(?<=[。！？.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function ThinkingReasoning({ reasoning, thinking, durationMs }: ThinkingReasoningProps) {
  const sentences = toSentences(reasoning);
  const done = !thinking;
  // 思考中始终展开；结束后折叠进摘要，用户可再展开。
  const [open, setOpen] = useState(false);
  // 展开后按滚动位置显示上下软遮罩。
  const [fade, setFade] = useState({ top: false, bottom: true });
  // 实测内容高度：真实句子长度不定，不能像演示版那样按固定行高估算。
  const [contentH, setContentH] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const measure = () => setContentH(el.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const expanded = done ? open : true;
  // 流式阶段交给外层 MessageStream 滚动，避免这里再创建一个滚动层。
  // 完成后才限制历史思考块高度，展开查看时使用内部滚动。
  const cappedNow = done && expanded && contentH > MAX_H;
  const viewH = cappedNow ? MAX_H : contentH;
  const scrollable = cappedNow;

  const showTop = scrollable ? fade.top : cappedNow;
  const showBottom = scrollable ? fade.bottom : cappedNow;
  const mask = cappedNow
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${
        showBottom ? FADE : 0
      }px), transparent 100%)`
    : "none";

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    setFade({
      top: el.scrollTop > 1,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    });
  };

  const toggle = () => {
    const next = !open;
    if (next) {
      setFade({ top: false, bottom: true });
      if (viewportRef.current) viewportRef.current.scrollTop = 0;
    }
    setOpen(next);
  };

  return (
    <div className={styles.tr}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label="切换思考过程"
        className={`${styles.trHeader}${done ? ` ${styles.isClickable}` : ""}`}
        onClick={done ? toggle : undefined}
      >
        {done ? (
          <span className={styles.trLabel}>
            <span className={styles.trVerb}>已思考</span>
            {durationMs !== undefined ? ` ${Math.max(1, Math.round(durationMs / 1000))} 秒` : ""}
          </span>
        ) : (
          <span className={`${styles.trLabel} ${styles.trShimmer}`}>思考中…</span>
        )}
        {done && (
          <svg
            aria-hidden="true"
            className={styles.trChevron}
            height="12"
            viewBox="0 0 24 24"
            width="12"
          >
            <path
              d="m4.5 15.75 7.5-7.5 7.5 7.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
          </svg>
        )}
      </button>

      <div className={`${styles.trCollapsible}${expanded ? "" : ` ${styles.isCollapsed}`}`}>
        <div className={styles.trInner}>
          <div
            className={`${styles.trViewport}${scrollable ? ` ${styles.isScroll}` : ""}`}
            ref={viewportRef}
            style={{
              height: `${expanded ? viewH : 0}px`,
              marginTop: expanded ? undefined : 0,
              WebkitMaskImage: mask,
              maskImage: mask,
            }}
            onScroll={scrollable ? onScroll : undefined}
          >
            <div className={styles.trStream} ref={streamRef}>
              {sentences.map((sentence, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 流式句子无稳定 id，且只追加不重排
                <p className={styles.trSentence} key={index}>
                  {sentence}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
