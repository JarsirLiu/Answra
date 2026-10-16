import type { ReactElement, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
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

/**
 * AI 正文：Markdown（GFM）+ KaTeX 行内/块级公式渲染，
 * 流式期间随文本增长实时重排；未闭合的 `$` 在闭合前保持原文。
 */
export function TextResponse({ text, caret = false }: { text: string; caret?: boolean }) {
  return (
    <div className={styles.prose} data-caret={caret || undefined}>
      <ReactMarkdown
        components={markdownComponents}
        rehypePlugins={[[rehypeKatex, { strict: false }]]}
        remarkPlugins={[remarkGfm, remarkMath]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
