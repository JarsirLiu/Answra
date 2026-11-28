/**
 * 增量切句：边收文本增量边产出可合成的段。
 *
 * 阈值参照 airi `tts-chunker`：开头若干段允许在逗号处提前结束（boost），
 * 但必须达到最少词数；句末标点直接结束；单段超过 provider 字符上限时硬切。
 * 这里只处理已净化的纯文本，不判断 Markdown。
 */

export interface TtsStreamChunkOptions {
  /** provider 单次请求字符上限，作为硬边界。 */
  readonly maxChars: number;
  /** 开头允许在逗号处提前结束的段数。 @default 2 */
  readonly boost?: number;
  /** boost/limit 段必须达到的词数。 @default 4 */
  readonly minimumWords?: number;
  /** 目标最大词数；超过后在标点处结束。 @default 12 */
  readonly maximumWords?: number;
}

export interface TtsStreamingChunker {
  push(delta: string): string[];
  flush(): string[];
}

const HARD_PUNCTUATIONS = new Set([".", "。", "?", "？", "!", "！", "…", "⋯", "~", "～", "\n"]);
const SOFT_PUNCTUATIONS = new Set([",", "，", "、", ":", "：", ";", "；", "—", "–"]);
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SOUND_PATTERN = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

export function createStreamingChunker(options: TtsStreamChunkOptions): TtsStreamingChunker {
  if (!Number.isInteger(options.maxChars) || options.maxChars < 1) {
    throw new RangeError("maxChars 必须是大于 0 的整数。");
  }
  const boost = options.boost ?? 2;
  const minimumWords = options.minimumWords ?? 4;
  const maximumWords = options.maximumWords ?? 12;

  /** 已确认属于当前段、但尚未决定在哪结束的文本。 */
  let chunk = "";
  /** 尚未扫描的文本（可能结尾是半个 `.` 或 `,`）。 */
  let pending = "";
  let emitted = 0;

  function drain(final: boolean): string[] {
    const out: string[] = [];
    let index = 0;

    while (index < pending.length) {
      const char = pending[index] as string;
      const isHard = HARD_PUNCTUATIONS.has(char);
      const isSoft = SOFT_PUNCTUATIONS.has(char);

      if (!isHard && !isSoft) {
        chunk += char;
        index += 1;
        if (chunk.length >= options.maxChars) {
          out.push(...hardSplit(chunk, options.maxChars));
          chunk = "";
        }
        continue;
      }

      const next = pending[index + 1];

      // `.` 与 `,` 可能是数字或 token 的一部分；结尾处先等下一个增量。
      if (char === "." || char === ",") {
        const previous = chunk.at(-1);
        if (next === undefined && !final) break;
        if (char === "." && next !== undefined && isTokenContinuation(next)) {
          chunk += char;
          index += 1;
          continue;
        }
        if (char === "," && isDigit(previous) && next !== undefined && isDigit(next)) {
          chunk += char;
          index += 1;
          continue;
        }
      }

      chunk += char;
      index += 1;

      const words = countWords(chunk);
      const shouldEmit =
        isHard || (emitted < boost && words >= minimumWords) || words > maximumWords;
      if (shouldEmit) {
        pushChunk(chunk, out);
        chunk = "";
        emitted += 1;
      }
    }

    pending = pending.slice(index);

    if (final) {
      pushChunk(chunk + pending, out);
      chunk = "";
      pending = "";
    }
    return out;
  }

  function pushChunk(value: string, out: string[]): void {
    const text = value.trim();
    if (text === "" || !SOUND_PATTERN.test(text)) return;
    out.push(...hardSplit(text, options.maxChars));
  }

  return {
    push(delta: string): string[] {
      if (delta === "") return [];
      pending += delta;
      return drain(false);
    },
    flush(): string[] {
      return drain(true);
    },
  };
}

function countWords(text: string): number {
  let count = 0;
  for (const segment of WORD_SEGMENTER.segment(text)) {
    if (segment.isWordLike === true) count += 1;
  }
  return count;
}

function isTokenContinuation(char: string): boolean {
  return !CJK_PATTERN.test(char) && /[\p{L}\p{N}_~/\\%@-]/u.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && /\d/.test(char);
}

function hardSplit(unit: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < unit.length) {
    let end = Math.min(start + maxChars, unit.length);
    const last = unit.charCodeAt(end - 1);
    if (end < unit.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    if (end === start) end = start + 1;
    chunks.push(unit.slice(start, end));
    start = end;
  }
  return chunks;
}
