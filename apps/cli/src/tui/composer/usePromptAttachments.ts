/** 输入框图片附件状态：只通过 ImageAttachmentReader 端口读取，不接触平台 I/O。 */
import { useCallback, useState } from "react";
import { type ImageAttachment, MAX_IMAGE_ATTACHMENTS } from "../../image/attachment";
import type { ImageAttachmentReader } from "../../image/ports";

export function usePromptAttachments({
  reader,
  onError,
}: {
  reader?: ImageAttachmentReader;
  onError?: (message: string) => void;
}) {
  const [images, setImages] = useState<readonly ImageAttachment[]>([]);
  const [reading, setReading] = useState(false);

  const add = useCallback(
    (incoming: readonly ImageAttachment[]) => {
      if (incoming.length === 0) return;
      const available = MAX_IMAGE_ATTACHMENTS - images.length;
      if (available <= 0) {
        onError?.(`单次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片`);
        return;
      }
      if (incoming.length > available) {
        onError?.(`单次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片`);
      }
      setImages((current) => [
        ...current,
        ...incoming.slice(0, Math.max(0, MAX_IMAGE_ATTACHMENTS - current.length)),
      ]);
    },
    [images.length, onError],
  );

  const readClipboard = useCallback(async () => {
    if (reader === undefined || reading) return;
    setReading(true);
    try {
      const found = await reader.readClipboard();
      if (found.length === 0) {
        onError?.("剪贴板中没有图片");
        return;
      }
      add(found);
    } catch (error) {
      onError?.(errorMessage(error));
    } finally {
      setReading(false);
    }
  }, [add, onError, reader, reading]);

  const readPaths = useCallback(
    async (paths: readonly string[]) => {
      if (reader === undefined || paths.length === 0) return;
      const available = MAX_IMAGE_ATTACHMENTS - images.length;
      if (available <= 0) {
        onError?.(`单次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片`);
        return;
      }
      if (paths.length > available) {
        onError?.(`单次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片`);
      }
      setReading(true);
      try {
        const found = await Promise.all(
          paths.slice(0, available).map((path) => reader.readPath(path)),
        );
        add(found);
      } catch (error) {
        onError?.(errorMessage(error));
      } finally {
        setReading(false);
      }
    },
    [add, images.length, onError, reader],
  );

  const removeLast = useCallback(() => {
    if (images.length === 0) return false;
    setImages((current) => current.slice(0, -1));
    return true;
  }, [images.length]);

  const clear = useCallback(() => setImages([]), []);

  return { images, reading, readClipboard, readPaths, removeLast, clear };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "读取图片失败";
}
