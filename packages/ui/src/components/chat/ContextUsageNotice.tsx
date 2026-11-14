import type { ContextUsage } from "@answra/shared";
import { Gauge } from "lucide-react";
import { contextUsageLabel } from "../../app/contextUsage";
import { ICON_SM } from "../../tokens";
import styles from "./ContextStatusNotice.module.css";

export function ContextUsageNotice({ usage }: { usage: ContextUsage }) {
  return (
    <div className={styles.notice}>
      <Gauge aria-hidden="true" size={ICON_SM} />
      <span className={styles.text}>{contextUsageLabel(usage)}</span>
    </div>
  );
}
