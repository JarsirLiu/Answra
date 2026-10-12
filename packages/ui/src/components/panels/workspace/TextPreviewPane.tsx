import type { WorkspaceFileContent } from "@answra/shared";
import { ZoomablePreview } from "./ZoomablePreview";

/**
 * 纯文本预览（txt/json 等）：等宽字体渲染，缩放由 `ZoomablePreview` 承担。
 */
export function TextPreviewPane({ content }: { content: WorkspaceFileContent }) {
  return (
    <ZoomablePreview className="workspace-preview-text-zoom">
      <pre className="workspace-preview-text">{content.text ?? ""}</pre>
    </ZoomablePreview>
  );
}
