/** 纯图片路径识别：只处理粘贴文本，不读文件系统；供 composer 与 Node 适配器共用。 */
import { fileURLToPath } from "node:url";

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const POSIX_ABSOLUTE = /^\//;

export interface ImagePaste {
  readonly paths: readonly string[];
  /** 同一段粘贴里不是绝对图片路径的部分，按原顺序保留为文本。 */
  readonly text: string;
}

/**
 * 拆分粘贴文本中的图片路径与其余文本。
 *
 * 支持换行分隔，以及拖拽多图时常见的“空格 + 绝对路径”分隔；只有绝对路径
 * 且扩展名受支持才视为图片，其余内容原样留给调用方插入，避免吞掉用户内容。
 */
export function parseImagePaste(text: string): ImagePaste {
  const parts = text
    .replace(/\r\n?/g, "\n")
    .split(/ (?=\/|[A-Za-z]:[\\/])/)
    .flatMap((part) => part.split("\n"))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const paths: string[] = [];
  const rest: string[] = [];
  for (const part of parts) {
    const path = imagePathFromLine(part);
    if (path === null) rest.push(part);
    else paths.push(path);
  }
  return { paths, text: rest.join("\n") };
}

/**
 * 从粘贴文本中提取图片路径。
 *
 * 只有全部内容都是绝对图片路径时才返回路径；混有普通文本时返回空数组，
 * 需要保留混合内容时改用 `parseImagePaste`。
 */
export function imagePathsFromText(text: string): readonly string[] {
  const paste = parseImagePaste(text);
  if (paste.text.length > 0) return [];
  return paste.paths;
}

function imagePathFromLine(line: string): string | null {
  let candidate = removeOuterQuotes(line);
  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  if (!IMAGE_EXTENSION.test(candidate)) return null;
  if (!WINDOWS_ABSOLUTE.test(candidate) && !POSIX_ABSOLUTE.test(candidate)) return null;
  return candidate;
}

function removeOuterQuotes(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && (first === '"' || first === "'") && last === first) {
    return value.slice(1, -1);
  }
  return value;
}
