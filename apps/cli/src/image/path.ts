/** 纯图片路径识别：只处理粘贴文本，不读文件系统；供 composer 与 Node 适配器共用。 */
import { fileURLToPath } from "node:url";

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const POSIX_ABSOLUTE = /^\//;

/**
 * 从粘贴文本中提取图片路径。
 *
 * 只有每一行都是绝对图片路径时才返回路径；混有普通文本时返回空数组，
 * 让调用方按普通文本粘贴，避免吞掉用户内容。
 */
export function imagePathsFromText(text: string): readonly string[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const paths = lines.map(imagePathFromLine);
  if (paths.some((path) => path === null)) return [];
  return paths as string[];
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
