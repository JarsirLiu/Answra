import { Check, ChevronDown, CodeXml, Copy } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ICON_SM } from "../../tokens";

const markdownComponents: Components = {
  code({ children, className }) {
    return <code className={className ?? "reply-conversation-inline-code"}>{children}</code>;
  },
  pre({ children }) {
    const code = children as ReactElement<{ className?: string; children?: ReactNode }>;
    const language = /language-(\w+)/.exec(code.props.className ?? "")?.[1] ?? "text";
    return <AicssCodeBlock code={String(code.props.children).replace(/\n$/, "")} lang={language} />;
  },
  table({ children }) {
    return (
      <div className="reply-conversation-table-scroll">
        <table>{children}</table>
      </div>
    );
  },
};

export function AicssMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
      {text}
    </ReactMarkdown>
  );
}

export function AicssTextResponse({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`aicss-text-response${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function AicssStreamingText({
  text,
  streaming,
  onReveal,
  render,
}: {
  text: string;
  streaming: boolean;
  onReveal: () => void;
  render: (visibleText: string) => ReactNode;
}) {
  const [visibleLength, setVisibleLength] = useState(text.length);
  const visibleLengthRef = useRef(text.length);
  const targetLengthRef = useRef(text.length);
  const onRevealRef = useRef(onReveal);
  const timerRef = useRef<number | null>(null);
  targetLengthRef.current = text.length;
  onRevealRef.current = onReveal;

  useEffect(() => {
    if (!streaming) {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      visibleLengthRef.current = text.length;
      setVisibleLength(text.length);
      return;
    }

    if (visibleLengthRef.current > text.length) visibleLengthRef.current = text.length;
    if (visibleLengthRef.current >= targetLengthRef.current || timerRef.current !== null) return;

    timerRef.current = window.setInterval(() => {
      if (visibleLengthRef.current >= targetLengthRef.current) {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        return;
      }
      visibleLengthRef.current = Math.min(visibleLengthRef.current + 2, targetLengthRef.current);
      setVisibleLength(visibleLengthRef.current);
      onRevealRef.current();
    }, 9);
  }, [streaming, text]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    },
    [],
  );

  const shownLength = streaming ? Math.min(visibleLength, text.length) : text.length;
  const isRevealing = streaming && shownLength < text.length;
  return (
    <>
      {render(text.slice(0, shownLength))}
      {streaming && <span className={`aicss-streaming-caret${isRevealing ? " is-steady" : ""}`} />}
    </>
  );
}

export function AicssCodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <section className="aicss-code-block">
      <header className="aicss-code-block-header">
        <span>
          <CodeXml aria-hidden="true" size={ICON_SM} />
          {lang}
        </span>
        <button
          aria-label={copied ? "代码已复制" : "复制代码"}
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
          type="button"
        >
          {copied ? (
            <Check aria-hidden="true" size={ICON_SM} />
          ) : (
            <Copy aria-hidden="true" size={ICON_SM} />
          )}
          {copied ? "已复制" : "复制"}
        </button>
      </header>
      <pre className="aicss-code-block-body">
        <code>{code}</code>
      </pre>
    </section>
  );
}

export function AicssThinkingState() {
  return <span className="aicss-thinking-state">正在思考</span>;
}

export function AicssThinkingReasoning({ text, isActive }: { text: string; isActive: boolean }) {
  const [expanded, setExpanded] = useState(isActive);

  useEffect(() => setExpanded(isActive), [isActive]);

  return (
    <section className="aicss-thinking-reasoning">
      <button
        aria-expanded={expanded}
        className="aicss-thinking-reasoning-header"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span
          className={`aicss-thinking-reasoning-label${isActive ? " aicss-thinking-state" : ""}`}
        >
          {isActive ? "正在思考" : "思考过程"}
        </span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      <div className={`aicss-thinking-reasoning-collapsible${expanded ? " is-expanded" : ""}`}>
        <div className="aicss-thinking-reasoning-inner">
          <div className="aicss-thinking-reasoning-body">
            <AicssTextResponse className="aicss-text-response--thinking">
              <AicssMarkdown text={text} />
            </AicssTextResponse>
          </div>
        </div>
      </div>
    </section>
  );
}
