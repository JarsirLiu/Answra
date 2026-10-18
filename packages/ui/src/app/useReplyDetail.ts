import { useCallback, useEffect, useState } from "react";
import type { ReplyPhase } from "../components/panels/ReplyBar";

/**
 * 回复条「展开对话面板」的开合状态。
 * 回退到发送条（composing）时自动折叠，避免留下一个空白发送条；
 * 展开期间支持按 Escape 收起。
 */
export function useReplyDetail(phase: ReplyPhase | "closed") {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (phase === "composing" || phase === "closed") setExpanded(false);
  }, [phase]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const toggle = useCallback(() => setExpanded((current) => !current), []);

  return { expanded, toggle };
}
