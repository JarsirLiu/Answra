import type { DesktopBridge, WorkspaceFileContent } from "@answra/shared";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { pasteImageName, resolveRelative, toResourceUrl } from "./fileKind";
import "./WorkspacePanel.css";

/**
 * markdown 编辑器（CodeMirror 6 懒加载）。
 *
 * 职责边界：本组件持有编辑器实例与脏状态；文件读写经 bridge 完成；
 * 外部变更由父层经 `content` prop 注入并触发冲突检查。
 */

export type EditorViewMode = "edit" | "preview";

interface MarkdownEditorPaneProps {
  path: string;
  /** 打开文件时的基线内容（磁盘版本）。 */
  content: WorkspaceFileContent;
  bridge: DesktopBridge | undefined;
  viewMode: EditorViewMode;
  onViewModeChange: (mode: EditorViewMode) => void;
  /** 外部修改通知（watcher 推送且路径匹配本文件）。 */
  externalVersion: number;
  /** 供外部（切换文件前）判断是否有未保存内容。 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 子资源（图片）相对路径解析基准：文档所在目录。 */
  dir: string;
}

interface CodeMirrorBundle {
  view: import("@codemirror/view").EditorView | null;
}

export function MarkdownEditorPane({
  path,
  content,
  bridge,
  viewMode,
  onViewModeChange,
  externalVersion,
  onDirtyChange,
  dir,
}: MarkdownEditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bundleRef = useRef<CodeMirrorBundle>({ view: null });
  const baselineRef = useRef<string>(content.text ?? "");
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setDirtyState = useCallback(
    (value: boolean) => {
      dirtyRef.current = value;
      setDirty(value);
      onDirtyChange?.(value);
    },
    [onDirtyChange],
  );

  // 挂载 CodeMirror（懒加载语言包，动态 import 不进主启动 chunk）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 编辑器实例仅在文件/视图模式变化时重建；粘贴与脏状态回调经 ref 读取，不作为响应依赖。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewMode !== "edit") return;
    let disposed = false;
    let view: import("@codemirror/view").EditorView | null = null;
    void (async () => {
      try {
        const [
          { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine },
          { defaultKeymap, history, historyKeymap },
          { markdown },
          { HighlightStyle, syntaxHighlighting },
          { tags },
        ] = await Promise.all([
          import("@codemirror/view"),
          import("@codemirror/commands"),
          import("@codemirror/lang-markdown"),
          import("@codemirror/language"),
          import("@lezer/highlight"),
        ]);
        if (disposed) return;
        const highlight = HighlightStyle.define([
          { tag: tags.heading1, fontWeight: "bold", fontSize: "1.1em" },
          { tag: [tags.heading2, tags.heading3, tags.heading4], fontWeight: "bold" },
          { tag: tags.strong, fontWeight: "bold" },
          { tag: tags.emphasis, fontStyle: "italic" },
          { tag: tags.link, color: "#3b82f6" },
          {
            tag: [tags.monospace],
            fontFamily: "Consolas, monospace",
            background: "rgba(128,128,128,.12)",
          },
        ]);
        view = new EditorView({
          parent: host,
          state: (await import("@codemirror/state")).EditorState.create({
            doc: baselineRef.current,
            extensions: [
              lineNumbers(),
              history(),
              drawSelection(),
              highlightActiveLine(),
              EditorView.lineWrapping,
              markdown(),
              syntaxHighlighting(highlight),
              keymap.of([...defaultKeymap, ...historyKeymap]),
              EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                setDirtyState(true);
              }),
              // 粘贴图片：拦截剪贴板图片文件，落盘 assets/ 并插入相对链接。
              EditorView.domEventHandlers({
                paste: (event) => {
                  const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
                    file.type.startsWith("image/"),
                  );
                  if (files.length === 0) return false;
                  event.preventDefault();
                  for (const file of files) void handlePasteImage(file);
                  return true;
                },
              }),
            ],
          }),
        });
        bundleRef.current.view = view;
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "编辑器加载失败");
      }
    })();
    return () => {
      disposed = true;
      view?.destroy();
      bundleRef.current.view = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, viewMode]);

  async function handlePasteImage(file: File) {
    if (!bridge?.writeWorkspaceBytes || !bundleRef.current.view) return;
    try {
      const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      const buffer = await file.arrayBuffer();
      const base64 = bytesToBase64(new Uint8Array(buffer));
      const name = pasteImageName(extension);
      const target = dir.length > 0 ? `${dir}/assets/${name}` : `assets/${name}`;
      await bridge.writeWorkspaceBytes(target, base64);
      const editor = bundleRef.current.view;
      editor.dispatch(editor.state.replaceSelection(`![](assets/${name})\n`));
      setDirtyState(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片保存失败");
    }
  }

  // 文件切换：重置基线。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在文件切换时重置基线；content.text 为该文件的打开快照。
  useEffect(() => {
    baselineRef.current = content.text ?? "";
    setDirtyState(false);
    setConflict(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // 外部变更：磁盘内容变化时，无未保存编辑则静默刷新，否则提示冲突。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 桥函数按引用稳定，不作为响应依赖；仅监听版本与路径。
  useEffect(() => {
    if (externalVersion === 0) return;
    if (!bridge?.readWorkspaceFile || dirtyRef.current) {
      if (dirtyRef.current) setConflict(true);
      return;
    }
    let cancelled = false;
    void bridge
      .readWorkspaceFile(path)
      .then((fresh) => {
        if (cancelled) return;
        baselineRef.current = fresh.text ?? "";
        const view = bundleRef.current.view;
        if (view) {
          const length = view.state.doc.length;
          view.dispatch({
            changes: { from: 0, to: length, insert: fresh.text ?? "" },
            selection: {
              anchor: Math.min(view.state.selection.main.anchor, (fresh.text ?? "").length),
            },
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalVersion, path]);

  const save = useCallback(async () => {
    if (!bridge?.writeWorkspaceFile || !dirtyRef.current) return;
    const view = bundleRef.current.view;
    const text = view ? view.state.doc.toString() : baselineRef.current;
    try {
      await bridge.writeWorkspaceFile(path, text);
      baselineRef.current = text;
      setDirtyState(false);
      setConflict(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    }
  }, [bridge, path, setDirtyState]);

  // 防抖自动保存（800ms）。
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void save(), 800);
    return () => clearTimeout(timer);
  }, [dirty, save]);

  // Ctrl/Cmd+S 手动保存。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  return (
    <div className="workspace-editor">
      <div className="workspace-editor__toolbar">
        <button
          type="button"
          className="workspace-editor__mode"
          onClick={() => onViewModeChange(viewMode === "edit" ? "preview" : "edit")}
        >
          {viewMode === "edit" ? "预览" : "编辑"}
        </button>
        {dirty ? (
          <span className="workspace-editor__status workspace-editor__status--dirty">未保存…</span>
        ) : (
          <span className="workspace-editor__status">已保存</span>
        )}
      </div>
      {conflict && (
        <div className="workspace-editor__conflict">
          文件已被外部修改，且本地有未保存编辑。
          <button type="button" onClick={() => void save()}>
            以本地为准覆盖
          </button>
          <button
            type="button"
            onClick={() => {
              setDirtyState(false);
              setConflict(false);
              void bridge?.readWorkspaceFile?.(path).then((fresh) => {
                baselineRef.current = fresh.text ?? "";
                const view = bundleRef.current.view;
                if (view)
                  view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: fresh.text ?? "" },
                  });
              });
            }}
          >
            采用外部版本
          </button>
        </div>
      )}
      {error && <div className="workspace-panel__error">{error}</div>}
      {viewMode === "edit" ? (
        <div ref={hostRef} className="workspace-editor__host" />
      ) : (
        <MarkdownStaticPreview text={baselineRef.current} dir={dir} />
      )}
    </div>
  );
}

/** react-markdown 组件在预览态用到的最小属性面（避免暴露完整 Options 泛型）。 */
interface MarkdownRendererProps {
  children?: string;
  remarkPlugins?: unknown[];
  components?: {
    img?: (props: { src?: unknown; alt?: unknown }) => ReactNode;
  };
}

/** 预览态：复用包内 react-markdown + remark-gfm，图片走 answra-file 协议。 */
function MarkdownStaticPreview({ text, dir }: { text: string; dir: string }) {
  const [renderer, setRenderer] = useState<null | ((props: MarkdownRendererProps) => ReactNode)>(
    null,
  );
  const [remarkGfm, setRemarkGfm] = useState<null | unknown>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([import("react-markdown"), import("remark-gfm")]).then(
      ([markdownModule, gfmModule]) => {
        if (cancelled) return;
        setRenderer(() => markdownModule.default as (props: MarkdownRendererProps) => ReactNode);
        setRemarkGfm(() => gfmModule.default);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (!renderer || !remarkGfm) return <div className="workspace-preview-status">预览加载中…</div>;
  const ReactMarkdown = renderer;
  return (
    <div className="workspace-preview-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            if (typeof src !== "string") return null;
            const altText = typeof alt === "string" ? alt : "";
            if (/^(https?:|data:|answra-file:)/.test(src)) return <img alt={altText} src={src} />;
            return <img alt={altText} src={toResourceUrl(resolveRelative(dir, src))} />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
