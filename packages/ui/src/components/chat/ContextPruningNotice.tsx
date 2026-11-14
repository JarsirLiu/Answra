import type { ContextPruningStatus } from "@answra/shared";
import { Eraser } from "lucide-react";
import { contextPruningLabel } from "../../app/contextUsage";
import { ICON_SM } from "../../tokens";
import styles from "./ContextStatusNotice.module.css";

export function ContextPruningNotice({ status }: { status: ContextPruningStatus }) {
  return (
    <div aria-live="polite" className={styles.notice} role="status">
      <Eraser aria-hidden="true" size={ICON_SM} />
      <span className={styles.text}>{contextPruningLabel(status)}</span>
    </div>
  );
}
