/**
 * 流式 Markdown 净化：把「不该读的符号」去掉，但保留可读正文。
 *
 * 增量的危险在于构造会跨帧：`**加粗**`、`[文字](链接)`、```` ``` ```` 可能被切开。
 * 因此每次 push 只输出**确定安全**的前缀，把可能是半个构造的尾巴留到下一帧；
 * `flush()` 时再无条件收尾，避免吞掉最后一段。
 */

export interface TtsSpeechSanitizer {
  push(delta: string): string;
  flush(): string;
}

const FENCE_MARKER_PATTERN = /^([ \t]{0,3})(`{3,}|~{3,})/;
const HTML_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;
const IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
const INLINE_CODE_PATTERN = /`([^`]*)`/g;
const HEADING_PATTERN = /^[ \t]{0,3}#{1,6}[ \t]+/gm;
const BLOCKQUOTE_PATTERN = /^[ \t]{0,3}>[ \t]?/gm;
const LIST_PATTERN = /^[ \t]{0,3}(?:[-+*]|\d+\.)[ \t]+/gm;
const HORIZONTAL_RULE_PATTERN = /^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm;
const EMPHASIS_PATTERN = /\*\*|__|~~|\*|_/g;
const REMAINING_BRACKET_PATTERN = /[[\]]/g;

/** 围栏内最多保留的尾部字符数：足够容纳跨帧的关闭标记。 */
const FENCE_CARRY_CHARS = 8;

export function createSpeechSanitizer(): TtsSpeechSanitizer {
  let pending = "";
  let inFence = false;
  let fenceChar: "`" | "~" = "`";

  function drain(final: boolean): string {
    let output = "";

    while (pending !== "") {
      if (inFence) {
        const close = findFenceClose(pending, fenceChar);
        if (close === -1) {
          if (final) {
            pending = "";
            inFence = false;
          } else {
            pending =
              pending.length > FENCE_CARRY_CHARS ? pending.slice(-FENCE_CARRY_CHARS) : pending;
          }
          break;
        }
        pending = pending.slice(close);
        inFence = false;
        continue;
      }

      const open = findFenceOpen(pending);
      if (open !== undefined) {
        output += sanitizeInline(pending.slice(0, open.index));
        const rest = pending.slice(open.index);
        const lineEnd = rest.indexOf("\n");
        if (lineEnd === -1 && !final) {
          pending = rest;
          break;
        }
        inFence = true;
        fenceChar = open.char;
        pending = lineEnd === -1 ? "" : rest.slice(lineEnd);
        continue;
      }

      if (final) {
        output += sanitizeInline(pending);
        pending = "";
        break;
      }

      const safeEnd = riskyTailStart(pending);
      output += sanitizeInline(pending.slice(0, safeEnd));
      pending = pending.slice(safeEnd);
      break;
    }

    return output;
  }

  return {
    push(delta: string): string {
      if (delta === "") return "";
      pending += delta;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}

/** 一次性净化整段文本；等价于 `push(text) + flush()`。 */
export function sanitizeSpeechText(text: string): string {
  const sanitizer = createSpeechSanitizer();
  return sanitizer.push(text) + sanitizer.flush();
}

function sanitizeInline(text: string): string {
  return text
    .replace(HORIZONTAL_RULE_PATTERN, "")
    .replace(IMAGE_PATTERN, "")
    .replace(LINK_PATTERN, "$1")
    .replace(INLINE_CODE_PATTERN, "$1")
    .replace(HTML_TAG_PATTERN, "")
    .replace(HEADING_PATTERN, "")
    .replace(BLOCKQUOTE_PATTERN, "")
    .replace(LIST_PATTERN, "")
    .replace(EMPHASIS_PATTERN, "")
    .replace(REMAINING_BRACKET_PATTERN, "");
}

interface FenceOpen {
  readonly index: number;
  readonly char: "`" | "~";
}

/** 找行首围栏；返回标记起点（语言标签不包含在 index 内）。 */
function findFenceOpen(text: string): FenceOpen | undefined {
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    const match = FENCE_MARKER_PATTERN.exec(line);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      const marker = match[2];
      const index = offset + match[1].length;
      return { index, char: marker[0] === "~" ? "~" : "`" };
    }
    offset += line.length + 1;
  }
  return undefined;
}

/** 返回关闭围栏整行之后的下标；找不到返回 -1。 */
function findFenceClose(text: string, char: "`" | "~"): number {
  const marker = char.repeat(3);
  const lines = text.split("\n");
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    if (index > 0 && line.trimStart().startsWith(marker)) {
      const lineEnd = offset + line.length;
      return lineEnd < text.length ? lineEnd + 1 : text.length;
    }
    if (index === 0 && line.trimStart().startsWith(marker)) {
      // 同一帧里 opener 与 closer 相邻：允许首行就是关闭标记。
      return line.length < text.length ? line.length + 1 : text.length;
    }
    offset += line.length + 1;
  }
  return -1;
}

/** 可能被下一帧补全的尾巴起点；之前的前缀可以安全输出。 */
function riskyTailStart(text: string): number {
  let start = text.length;

  const emphasisRun = /[*_~`]+$/.exec(text);
  if (emphasisRun !== null) start = Math.min(start, emphasisRun.index);

  const lastAngle = text.lastIndexOf("<");
  if (lastAngle !== -1 && text.indexOf(">", lastAngle) === -1) {
    start = Math.min(start, lastAngle);
  }

  const lastOpen = text.lastIndexOf("[");
  if (lastOpen !== -1 && text.indexOf("]", lastOpen) === -1) {
    start = Math.min(start, imageStart(text, lastOpen));
  }

  const trimmedEnd = text.trimEnd();
  if (trimmedEnd.endsWith("]")) {
    const close = trimmedEnd.length - 1;
    const open = findMatchingOpen(trimmedEnd, close);
    if (open !== -1) start = Math.min(start, imageStart(trimmedEnd, open));
  }

  const destination = text.lastIndexOf("](");
  if (destination !== -1 && text.indexOf(")", destination) === -1) {
    const open = findMatchingOpen(text, destination);
    start = Math.min(start, open === -1 ? destination : imageStart(text, open));
  }

  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);
  if (/^[ \t]{0,3}(?:#{1,6}|[-+*>]|\d+\.)[ \t]*$/.test(line)) {
    start = Math.min(start, lineStart);
  }

  return start;
}

function imageStart(text: string, open: number): number {
  return open > 0 && text[open - 1] === "!" ? open - 1 : open;
}

function findMatchingOpen(text: string, closeIndex: number): number {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    const char = text[index];
    if (char === "]") depth += 1;
    else if (char === "[") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
