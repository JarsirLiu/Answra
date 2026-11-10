import type { ReactNode } from "react";
import styles from "./toolCallContent.module.css";

export function ToolDetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className={styles.panel} data-tool-panel="">
      <div className={styles.label}>{label}</div>
      <div className={styles.content}>{children}</div>
    </section>
  );
}

export function ToolOutputBlock({
  text,
  tone = "normal",
  wrap = true,
}: {
  text: string;
  tone?: "normal" | "error";
  wrap?: boolean;
}) {
  return (
    <pre className={styles.pre} data-tone={tone} data-wrap={wrap ? undefined : "false"}>
      {text}
    </pre>
  );
}

export function ToolErrorBlock({ text }: { text: string }) {
  return (
    <ToolDetailSection label="错误">
      <ToolOutputBlock text={text} tone="error" />
    </ToolDetailSection>
  );
}

export function ToolNotice({ children }: { children: ReactNode }) {
  return <p className={styles.notice}>{children}</p>;
}
