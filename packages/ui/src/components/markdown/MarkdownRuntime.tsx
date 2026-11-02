import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type RehypePlugins = ComponentProps<typeof ReactMarkdown>["rehypePlugins"];

interface MarkdownRuntimeProps {
  children: string;
  mode: "chat" | "safe-preview";
  components?: Components;
}

export function MarkdownRuntime({ children, mode, components }: MarkdownRuntimeProps) {
  const rehypePlugins: RehypePlugins =
    mode === "chat" ? [[rehypeKatex, { strict: false }]] : [rehypeRaw, rehypeSanitize, rehypeKatex];
  return (
    <ReactMarkdown
      components={components}
      rehypePlugins={rehypePlugins}
      remarkPlugins={[remarkGfm, remarkMath]}
    >
      {children}
    </ReactMarkdown>
  );
}
