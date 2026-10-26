import { useLayoutEffect, useRef, useState } from "react";
import styles from "./ThinkingReasoning.module.css";

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

function latestLine(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf("\n");
  return (newline === -1 ? visible : visible.slice(newline + 1)).trim();
}

/**
 * 思维链折叠块：默认只显示一行状态摘要，点开才渲染完整思考过程。
 * 思考中摘要跟随最新一行并横向滚到行尾，完成后回到首行。
 */
export function ThinkingReasoning({ reasoning, thinking, durationMs }: ThinkingReasoningProps) {
  const sentences = toSentences(reasoning);
  const done = !thinking;
  const [open, setOpen] = useState(false);
  const summaryRef = useRef<HTMLSpanElement>(null);
  // 思考中只看最新一行；结束后只保留时长标题，不再展示摘要。
  const summary = thinking ? latestLine(reasoning) : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: summary 是文本指纹，依赖它驱动横向跟随
  useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth - el.clientWidth;
  }, [thinking, summary]);

  return (
    <div className={styles.tr}>
      <button
        type="button"
        aria-expanded={open}
        aria-label="切换思考过程"
        className={`${styles.trHeader} ${styles.isClickable}`}
        onClick={() => setOpen((value) => !value)}
      >
        {done ? (
          <span className={styles.trLabel}>
            <span className={styles.trVerb}>已思考</span>
            {durationMs !== undefined ? ` ${Math.max(1, Math.round(durationMs / 1000))} 秒` : ""}
          </span>
        ) : (
          <span className={`${styles.trLabel} ${styles.trShimmer}`}>思考中…</span>
        )}
        {!open && summary ? (
          <>
            <span aria-hidden="true" className={styles.trSeparator} />
            <span
              className={styles.trSummary}
              data-follow-end={thinking || undefined}
              ref={summaryRef}
            >
              {summary}
            </span>
          </>
        ) : null}
        <svg
          aria-hidden="true"
          className={styles.trChevron}
          height="12"
          viewBox="0 0 24 24"
          width="12"
        >
          <path
            d="m8.25 4.5 7.5 7.5-7.5 7.5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      </button>

      <div className={`${styles.trCollapsible}${open ? "" : ` ${styles.isCollapsed}`}`}>
        <div className={styles.trInner}>
          {open ? (
            <div className={styles.trBody}>
              {sentences.map((sentence, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 流式句子无稳定 id，且只追加不重排
                <p className={styles.trSentence} key={index}>
                  {sentence}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
