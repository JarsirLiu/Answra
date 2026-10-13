import { ArrowDown } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./MessageStream.module.css";

/** 判定视口是否停留在底部附近（40px 容差）。 */
function isNearBottom(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 40;
}

/**
 * 「跟随最新回复」滚动控制器：
 * - 内容增长时自动滚动到底部（跟随模式）
 * - 用户上滑离开底部即退出跟随，回到底部后自动恢复
 * - contentKey 由调用方构造，内容/流式增长时变化即可触发跟随
 */
export function useFollowLatest(contentKey: string) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const [showJump, setShowJump] = useState(false);

  const sync = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setFollowing(followingRef.current);
    setShowJump(!followingRef.current && viewport.scrollHeight > viewport.clientHeight + 40);
  }, []);

  // 内容变化：跟随模式下滚到底部，并刷新按钮可见性
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey 是内容指纹，故意作为触发信号列入依赖
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (followingRef.current) viewport.scrollTop = viewport.scrollHeight;
    sync();
  }, [contentKey, sync]);

  // 尺寸变化（折叠思考、窗口缩放）时同步按钮可见性
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [sync]);

  const onScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followingRef.current = isNearBottom(viewport);
    sync();
  }, [sync]);

  /** 平滑滚动到最新回复并恢复跟随。 */
  const scrollToLatest = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followingRef.current = true;
    setFollowing(true);
    setShowJump(false);
    viewport.scrollTo({ behavior: "smooth", top: viewport.scrollHeight });
  }, []);

  return { viewportRef, onScroll, scrollToLatest, following, showJump };
}

interface MessageStreamProps {
  /** 内容指纹：消息条数/文本长度变化时更新，用于驱动自动跟随。 */
  contentKey: string;
  /** 视口可访问名称。 */
  ariaLabel?: string;
  className?: string;
  /** 附加到滚动视口上的类名（如消息间距/内边距）。 */
  viewportClassName?: string;
  children: ReactNode;
}

/**
 * 消息流视口：纵向滚动容器 + 「定位到最新回复」浮动按钮。
 * 可独立复用（回复条展开页替换时直接套用），子组件自由拼装。
 */
export function MessageStream({
  contentKey,
  ariaLabel,
  className,
  viewportClassName,
  children,
}: MessageStreamProps) {
  const { viewportRef, onScroll, scrollToLatest, showJump } = useFollowLatest(contentKey);
  return (
    <div className={`${styles.stream}${className ? ` ${className}` : ""}`}>
      <div
        aria-label={ariaLabel}
        className={`${styles.viewport}${viewportClassName ? ` ${viewportClassName}` : ""}`}
        onScroll={onScroll}
        ref={viewportRef}
        role="log"
      >
        {children}
      </div>
      {showJump && (
        <button
          aria-label="定位到最新回复"
          className={styles.jumpButton}
          onClick={scrollToLatest}
          type="button"
        >
          <ArrowDown aria-hidden="true" size={14} />
          最新回复
        </button>
      )}
    </div>
  );
}
