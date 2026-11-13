import type { ContextCompactionStatus } from "@answra/shared";
import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { contextCompactionLabel } from "../../app/contextCompaction";
import { ICON_SM } from "../../tokens";
import styles from "./ContextCompactionNotice.module.css";

interface ContextCompactionNoticeProps {
  status: ContextCompactionStatus;
}

/** 上下文摘要压缩的独立状态行；不冒充模型错误或普通回复。 */
export function ContextCompactionNotice({ status }: ContextCompactionNoticeProps) {
  if (status.state === "idle") return null;
  const failed = status.state === "failed";
  return (
    <div
      aria-live="polite"
      className={`${styles.notice} ${failed ? styles.failed : ""}`}
      role={failed ? "alert" : "status"}
    >
      <Icon state={status.state} />
      <span className={styles.text}>{contextCompactionLabel(status)}</span>
    </div>
  );
}

function Icon({ state }: { state: ContextCompactionStatus["state"] }) {
  if (state === "succeeded") return <CircleCheck aria-hidden="true" size={ICON_SM} />;
  if (state === "failed") return <TriangleAlert aria-hidden="true" size={ICON_SM} />;
  return <LoaderCircle aria-hidden="true" className={styles.spinner} size={ICON_SM} />;
}
