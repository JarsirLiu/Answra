import type { ReactElement, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./TextResponse.module.css";

const markdownComponents: Components = {
  code({ children, className }) {
    return <code className={className ?? styles.inlineCode}>{children}</code>;
  },
  pre({ children }) {
    const code = children as ReactElement<{ className?: string; children?: ReactNode }>;
    const language = /language-(\w+)/.exec(code.props.className ?? "")?.[1] ?? "text";
    return (
      <div className={styles.codeBlock}>
        <span className={styles.codeLang}>{language}</span>
        <pre>
          <code>{String(code.props.children).replace(/\n$/, "")}</code>
        </pre>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className={styles.tableScroll}>
        <table>{children}</table>
      </div>
    );
  },
};

/** AI 正文：Markdown 渲染（GFM），流式期间随文本增长实时重排。 */
export function TextResponse({ children }: { children?: ReactNode }) {
  return (
    <div className={styles.prose}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {typeof children === "string" ? children : ""}
      </ReactMarkdown>
    </div>
  );
}
