import type { WorkspaceFileContent } from "@answra/shared";
import { useEffect, useRef, useState } from "react";

/**
 * docx 预览：docx-preview 在渲染进程把 ArrayBuffer 渲染为 HTML。
 * 与 Codex 桌面版同款技术路线（纯前端解析，不依赖 Office）。
 */
export function DocxPreviewPane({ content }: { content: WorkspaceFileContent }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    void (async () => {
      try {
        const [{ renderAsync }, { default: jszipModule }] = await Promise.all([
          import("docx-preview"),
          import("jszip"),
        ]);
        if (cancelled) return;
        const bytes = base64ToBytes(content.dataBase64);
        const zip = await jszipModule.loadAsync(bytes);
        host.replaceChildren();
        await renderAsync(zip, host, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          experimental: true,
          useBase64URL: true,
        });
        if (!cancelled) setStatus("ready");
      } catch (cause) {
        if (!cancelled) {
          setStatus("error");
          setError(cause instanceof Error ? cause.message : "docx 解析失败");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content]);

  return (
    <div className="workspace-preview-docx-wrap" style={{ display: "flex", flex: 1, minHeight: 0 }}>
      {status === "loading" && <div className="workspace-preview-status">docx 解析中…</div>}
      {status === "error" && <div className="workspace-preview-status">{error}</div>}
      <div ref={hostRef} className="workspace-preview-docx" />
    </div>
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
