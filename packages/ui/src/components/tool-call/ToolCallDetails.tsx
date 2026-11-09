import type { ReactNode } from "react";
import styles from "./toolCallContent.module.css";

export function ToolDetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.label}>{label}</div>
      {children}
    </section>
  );
}

export function ToolOutputBlock({
  text,
  tone = "normal",
}: {
  text: string;
  tone?: "normal" | "error";
}) {
  return (
    <pre className={styles.pre} data-tone={tone}>
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
