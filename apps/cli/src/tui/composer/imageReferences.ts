/** 输入框内联图片引用：只负责 [Image #N] 的解析与定位，不读剪贴板或文件。 */
import type { ImageAttachment } from "../../image/attachment";

const IMAGE_REFERENCE_PATTERN = /\[Image #(\d+)\]/g;

export interface ImageReference {
  readonly id: number;
  readonly start: number;
  readonly end: number;
}

export interface PromptImageEntry {
  readonly id: number;
  readonly attachment: ImageAttachment;
}

export function formatImageReference(id: number): string {
  return `[Image #${id}]`;
}

export function imageReferences(text: string): readonly ImageReference[] {
  const references: ImageReference[] = [];
  for (const match of text.matchAll(IMAGE_REFERENCE_PATTERN)) {
    const id = Number.parseInt(match[1] ?? "", 10);
    const start = match.index;
    if (start === undefined) continue;
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    references.push({ id, start, end: start + match[0].length });
  }
  return references;
}

export function referencedImageIds(text: string): readonly number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const reference of imageReferences(text)) {
    if (seen.has(reference.id)) continue;
    seen.add(reference.id);
    ids.push(reference.id);
  }
  return ids;
}

/** 历史记录不恢复图片，保存前去掉引用标记，避免出现无附件的悬空引用。 */
export function stripImageReferences(text: string): string {
  return text
    .replace(IMAGE_REFERENCE_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function resolveImageAttachments(
  text: string,
  entries: readonly PromptImageEntry[],
): readonly ImageAttachment[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry.attachment]));
  const resolved: ImageAttachment[] = [];
  for (const id of referencedImageIds(text)) {
    const attachment = byId.get(id);
    if (attachment !== undefined) resolved.push(attachment);
  }
  return resolved;
}

/** 紧贴光标左侧结束的引用；用于 Backspace 和左移整块跳过。 */
export function imageReferenceEndingAt(text: string, cursor: number): ImageReference | undefined {
  return imageReferences(text).find((reference) => reference.end === cursor);
}

/** Backspace 语义：引用后紧跟的一个空格与其一起删除。 */
export function imageReferenceEndingBeforeCursor(
  text: string,
  cursor: number,
): ImageReference | undefined {
  const direct = imageReferenceEndingAt(text, cursor);
  if (direct !== undefined) return direct;
  if (text[cursor - 1] !== " ") return undefined;
  const beforeSpace = imageReferenceEndingAt(text, cursor - 1);
  return beforeSpace === undefined ? undefined : { ...beforeSpace, end: cursor };
}

/** 光标位于引用内部或结尾时返回该引用；用于左移。 */
export function imageReferenceBefore(text: string, cursor: number): ImageReference | undefined {
  return imageReferences(text).find(
    (reference) => reference.start < cursor && cursor <= reference.end,
  );
}

/** 紧贴光标右侧开始的引用；用于 Delete。 */
export function imageReferenceStartingAt(text: string, cursor: number): ImageReference | undefined {
  return imageReferences(text).find((reference) => reference.start === cursor);
}

/** 光标位于引用开头或内部时返回该引用；用于右移。 */
export function imageReferenceAfter(text: string, cursor: number): ImageReference | undefined {
  return imageReferences(text).find(
    (reference) => reference.start <= cursor && cursor < reference.end,
  );
}
