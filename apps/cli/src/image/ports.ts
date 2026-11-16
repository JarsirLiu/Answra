/** CLI 图片读取端口；composer 只依赖此接口，平台实现由 adapters 注入。 */
import type { ImageAttachment } from "./attachment";

export interface ImageAttachmentReader {
  readClipboard(): Promise<readonly ImageAttachment[]>;
  readPath(path: string): Promise<ImageAttachment>;
}
