import type { ReactNode } from "react";
import styles from "./ToolResponse.module.css";

interface ToolResponseProps {
  /** 工具名，如 "run_tests"。 */
  name: string;
  /** 执行状态。 */
  status?: "running" | "done" | "error";
  /** 工具输出/结果内容。 */
  children?: ReactNode;
}

/**
 * 工具调用部件（预留）：与思考、正文同级，可由 AssistantMessage children 插入，
 * 后续接入 function-call 流时直接渲染即可。
 */
export function ToolResponse({ name, status = "done", children }: ToolResponseProps) {
  return (
    <div className={styles.tool} data-status={status}>
      <span className={styles.name}>{name}</span>
      {children ? <div className={styles.output}>{children}</div> : null}
    </div>
  );
}
