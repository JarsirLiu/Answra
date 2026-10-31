import { Check, Copy } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import styles from "./TextResponse.module.css";

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 900);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* 剪贴板不可用时仍展示已复制状态，与消息操作条保持一致。 */
    }
    setCopied(true);
  };

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span className={styles.codeLang}>{language}</span>
        <button
          type="button"
          className={styles.copyButton}
          aria-label={copied ? "已复制代码" : "复制代码"}
          onClick={copy}
        >
          {copied ? <Check aria-hidden="true" size={13} /> : <Copy aria-hidden="true" size={13} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  code({ children, className }) {
    return <code className={className ?? styles.inlineCode}>{children}</code>;
  },
  pre({ children }) {
    const code = children as ReactElement<{ className?: string; children?: ReactNode }>;
    const language = /language-(\w+)/.exec(code.props.className ?? "")?.[1] ?? "text";
    const codeText = String(code.props.children).replace(/\n$/, "");
    return <CodeBlock code={codeText} language={language} />;
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
