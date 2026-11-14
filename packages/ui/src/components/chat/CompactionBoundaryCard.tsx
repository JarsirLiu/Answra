import type { ContextCompactionBoundary } from "@answra/shared";
import { Sparkles } from "lucide-react";
import { useId, useState } from "react";
import { ICON_SM } from "../../tokens";
import { SurfaceButton } from "../controls/SurfaceButton";
import styles from "./CompactionBoundaryCard.module.css";

/** 桌面端的压缩边界卡：默认展示摘要元数据，展开后显示摘要正文。 */
export function CompactionBoundaryCard({ boundary }: { boundary: ContextCompactionBoundary }) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  return (
    <section aria-label="上下文已压缩" className={styles.boundary}>
      <div className={styles.header}>
        <Sparkles aria-hidden="true" className={styles.icon} size={ICON_SM} />
        <span className={styles.title}>上下文已压缩</span>
        {expanded ? null : (
          <span className={styles.meta}>已摘要 {boundary.summarizedMessages} 条消息</span>
        )}
        <SurfaceButton
          aria-controls={expanded ? summaryId : undefined}
          aria-expanded={expanded}
          className={styles.toggle}
          onClick={() => setExpanded((value) => !value)}
          size="xs"
          variant="quiet"
        >
          {expanded ? "收起摘要" : "展开摘要"}
        </SurfaceButton>
      </div>
      {expanded ? (
        <pre className={styles.summary} id={summaryId}>
          {boundary.summary}
        </pre>
      ) : boundary.instructions === undefined ? null : (
        <p className={styles.context}>摘要重点：“{boundary.instructions}”</p>
      )}
    </section>
  );
}
