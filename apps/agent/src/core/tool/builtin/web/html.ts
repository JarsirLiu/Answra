/** 轻量 HTML 文本化与 Bing 结果页解析；不引入解析依赖，也不执行页面脚本。 */

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/giu, (match, hex, dec, name) => {
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
    if (dec !== undefined) return codePoint(Number.parseInt(dec, 10));
    const decoded = HTML_ENTITIES[name.toLowerCase()];
    return decoded ?? match;
  });
}

function codePoint(value: number): string {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 0x10ffff ||
    (value >= 0xd800 && value <= 0xdfff)
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(value);
}

export function normalizeText(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => line.replace(/[ \t\u00a0]+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 去掉脚本/样式等非正文标签，按块级标签断行；只做文本投影，不渲染页面。 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(
      /<(script|style|noscript|iframe|object|embed|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
      "",
    )
    .replace(/<\s*br\s*\/?\s*>/giu, "\n")
    .replace(/<\/(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote|pre)>/giu, "\n")
    .replace(/<[^>]*>/gu, "");
  return normalizeText(decodeHtmlEntities(stripped));
}

export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

const BING_RESULT = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/giu;
const BING_TITLE = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu;
const BING_CAPTION = /<div[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\/div>/iu;

/** 解析 Bing 结果页 ordinary result 块；解析不到就返回空数组，由工具显式说明。 */
export function parseBingResults(html: string, limit: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  for (const match of html.matchAll(BING_RESULT)) {
    const block = match[1] ?? "";
    const titleMatch = BING_TITLE.exec(block);
    if (titleMatch === null) continue;
    const url = decodeHtmlEntities(titleMatch[1] ?? "");
    if (!/^https?:\/\//iu.test(url)) continue;
    const title = htmlToText(titleMatch[2] ?? "");
    const snippet = htmlToText(BING_CAPTION.exec(block)?.[1] ?? "");
    hits.push({ title, url, snippet });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 模型可见的搜索结果：编号 + Markdown 链接 + 摘要，不返回原始 HTML。 */
export function formatSearchResults(query: string, hits: readonly WebSearchHit[]): string {
  if (hits.length === 0) {
    return `未找到与「${query}」相关的搜索结果，请换关键词重试。`;
  }
  const body = hits
    .map((hit, index) => {
      const snippet = hit.snippet.length === 0 ? "" : `\n  ${hit.snippet}`;
      return `${index + 1}. [${hit.title}](${hit.url})${snippet}`;
    })
    .join("\n");
  return `搜索「${query}」（${hits.length} 条）：\n${body}`;
}
