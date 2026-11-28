import { Search } from "lucide-react";
import { ToolCallCard } from "../ToolCallCard";
import { ToolDetailSection, ToolErrorBlock, ToolOutputBlock } from "../ToolCallDetails";
import type { ToolCallRendererProps } from "../toolCallPart";
import { asRecord, clipText, MAX_TOOL_VALUE_CHARS, stringField } from "../toolCallPresentation";
import styles from "./webSearch.module.css";

interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
}

type SearchOutput =
  | { readonly kind: "hits"; readonly hits: readonly WebSearchHit[]; readonly total: number }
  | { readonly kind: "empty" }
  | { readonly kind: "raw"; readonly text: string };

const RESULT_HEADER = /^搜索「[\s\S]*」（(\d+) 条）：$/u;
const RESULT_LINE = /^\d+\. \[(.+)\]\((https?:\/\/\S+)\)$/u;
const SNIPPET_LINE = /^\s{2,}(\S.*)$/u;
const EMPTY_RESULT = /^未找到与「[\s\S]*」相关的搜索结果/u;

/**
 * WebSearch：摘要行渲染成只读搜索框（关键词 + 结果数），展开后列出标题、域名与摘要。
 * 只读取工具输出文本里的固定格式；解析不了就原样展示，不猜结构。
 */
export function WebSearchToolCall({ part }: ToolCallRendererProps) {
  const input = asRecord(part.input);
  const query = input ? stringField(input, "query") : undefined;
  const parsed = parseSearchOutput(part.output);
  const error = part.errorText ? clipText(part.errorText, MAX_TOOL_VALUE_CHARS) : undefined;
  const hits = parsed?.kind === "hits" ? parsed.hits : [];
  const total = parsed?.kind === "hits" ? parsed.total : undefined;
  const summaryExtra =
    part.state === "completed"
      ? parsed?.kind === "empty"
        ? "未找到"
        : total === undefined
          ? undefined
          : `${total} 条结果`
      : undefined;
  const hasDetails = error !== undefined || parsed?.kind === "hits" || parsed?.kind === "raw";

  return (
    <ToolCallCard
      actionLabel="搜索网页"
      icon={<Search size={14} />}
      part={part}
      primary={query ?? part.title ?? "搜索"}
      summaryExtra={summaryExtra}
      variant="search"
    >
      {hasDetails ? (
        <>
          {error ? <ToolErrorBlock text={error.text} /> : null}
          {parsed?.kind === "hits" ? (
            <ToolDetailSection label={`结果 · ${total ?? hits.length} 条`}>
              <div className={styles.hits}>
                {hits.map((hit) => (
                  <div className={styles.hit} key={`${hit.title}:${hit.url}`}>
                    <div className={styles.hitTitle}>{hit.title}</div>
                    <div className={styles.hitUrl}>{hit.url}</div>
                    {hit.snippet ? <p className={styles.hitSnippet}>{hit.snippet}</p> : null}
                  </div>
                ))}
              </div>
            </ToolDetailSection>
          ) : null}
          {parsed?.kind === "raw" ? (
            <ToolDetailSection label="结果">
              <ToolOutputBlock text={parsed.text} />
            </ToolDetailSection>
          ) : null}
        </>
      ) : undefined}
    </ToolCallCard>
  );
}

/** 解析 formatSearchResults 的文本；空结果、命中和无法识别三种形态分别返回。 */
export function parseSearchOutput(value: unknown): SearchOutput | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\r\n", "\n").trim();
  if (normalized.length === 0) return undefined;
  const lines = normalized.split("\n");
  const header = RESULT_HEADER.exec(lines[0] ?? "");
  if (header === null) {
    if (EMPTY_RESULT.test(lines[0] ?? "")) return { kind: "empty" };
    return { kind: "raw", text: normalized };
  }
  const hits: WebSearchHit[] = [];
  for (const line of lines.slice(1)) {
    const hit = RESULT_LINE.exec(line);
    if (hit?.[1] !== undefined && hit[2] !== undefined) {
      hits.push({ title: hit[1], url: hit[2] });
      continue;
    }
    const snippet = SNIPPET_LINE.exec(line)?.[1]?.trim();
    const current = hits.at(-1);
    if (snippet !== undefined && current !== undefined && current.snippet === undefined) {
      current.snippet = snippet;
    }
  }
  const total = Number.parseInt(header[1] ?? "", 10);
  return { kind: "hits", hits, total: Number.isNaN(total) ? hits.length : total };
}
