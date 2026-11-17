/** 输入框图片附件状态：按 [Image #N] 引用持有附件，只经 ImageAttachmentReader 读取。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type ImageAttachment, MAX_IMAGE_ATTACHMENTS } from "../../image/attachment";
import type { ImageAttachmentReader } from "../../image/ports";
import type { PromptImageEntry } from "./imageReferences";

/** 读取很快时不要闪现“正在读取图片”，只在超过该阈值后显示。 */
const READING_INDICATOR_DELAY_MS = 500;

export function usePromptAttachments({
  reader,
  onError,
}: {
  reader?: ImageAttachmentReader;
  onError?: (message: string) => void;
}) {
  const [entries, setEntries] = useState<readonly PromptImageEntry[]>([]);
  const [reading, setReading] = useState(false);
  const [showReading, setShowReading] = useState(false);
  const nextIdRef = useRef(1);
  const readingRef = useRef(false);

  useEffect(() => {
    if (!reading) {
      setShowReading(false);
      return;
    }
    const timer = setTimeout(() => setShowReading(true), READING_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [reading]);

  const attach = useCallback(
    (incoming: readonly ImageAttachment[]): readonly number[] => {
      if (incoming.length === 0) return [];
      const available = MAX_IMAGE_ATTACHMENTS - entries.length;
      if (available <= 0) {
        onError?.(`单次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片`);
        return [];
      }
      if (incoming.length > available) {
        onError?.(`单次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片`);
      }
      const accepted = incoming.slice(0, available).map((attachment) => ({
        id: nextIdRef.current++,
        attachment,
      }));
      setEntries((current) => [...current, ...accepted]);
      return accepted.map((entry) => entry.id);
    },
    [entries.length, onError],
  );

  const readClipboard = useCallback(async (): Promise<readonly ImageAttachment[]> => {
    if (reader === undefined || readingRef.current) return [];
    readingRef.current = true;
    setReading(true);
    try {
      const found = await reader.readClipboard();
      if (found.length === 0) onError?.("剪贴板中没有图片");
      return found;
    } catch (error) {
      onError?.(errorMessage(error));
      return [];
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  }, [onError, reader]);

  const readPaths = useCallback(
    async (paths: readonly string[]): Promise<readonly ImageAttachment[]> => {
      if (reader === undefined || paths.length === 0 || readingRef.current) return [];
      readingRef.current = true;
      setReading(true);
      try {
        const results = await Promise.allSettled(paths.map((path) => reader.readPath(path)));
        const found: ImageAttachment[] = [];
        let firstFailure: string | undefined;
        for (const result of results) {
          if (result.status === "fulfilled") found.push(result.value);
          else firstFailure ??= errorMessage(result.reason);
        }
        if (firstFailure !== undefined) onError?.(firstFailure);
        return found;
      } finally {
        readingRef.current = false;
        setReading(false);
      }
    },
    [onError, reader],
  );

  const prune = useCallback((referencedIds: readonly number[]) => {
    setEntries((current) => {
      const keep = new Set(referencedIds);
      const next = current.filter((entry) => keep.has(entry.id));
      return next.length === current.length ? current : next;
    });
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  return { entries, reading: showReading, attach, readClipboard, readPaths, prune, clear };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "读取图片失败";
}
