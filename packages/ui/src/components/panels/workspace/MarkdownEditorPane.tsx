import type { DesktopBridge, WorkspaceFileContent } from "@answra/shared";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useEmbeddedIme } from "../../../hooks/useEmbeddedIme";
import {
  applyCodeMirrorImeCommand,
  codeMirrorImeCompositionField,
  createCodeMirrorTextAdapter,
  setCodeMirrorImeComposition,
} from "../../../ime/adapters/codeMirrorTextAdapter";
import { handleImeEditorKeyDown, imeEditorAttributes } from "../../../ime/imeEditorBinding";
import { ImeCandidateAnchorReporter } from "../ImeCandidateAnchorReporter";
import { pasteImageName, resolveRelative, toResourceUrl } from "./fileKind";
import { ZoomablePreview } from "./ZoomablePreview";
import "./WorkspacePanel.css";

/**
 * markdown 面板：两种模式。
 *
 * - 源码（默认）：CodeMirror 6 编辑原始 markdown。
 * - 预览：react-markdown + remark-gfm + rehype-raw 静态渲染
 *   （内嵌 HTML 如 br/a 经 rehype-raw 渲染，rehype-sanitize 兜底安全），
 *   图片走 answra-file 协议。
 *
 * 职责边界：本组件持有编辑器实例与脏状态；文件读写经 bridge 完成；
 * 外部变更由父层经 `content` prop 注入并触发冲突检查（主进程已抑制
 * 自身写盘的 watcher 回声，此处收到的 externalVersion 均为真外部修改）。
 */

export type EditorViewMode = "source" | "preview";

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
  const ime = useEmbeddedIme(
    bridge,
    (text) => {
      const view = bundleRef.current.view;
      if (!view) return;
      createCodeMirrorTextAdapter(view).insertText(text);
      setDirtyState(true);
    },
    true,
    "workspace-markdown-editor",
  );
  const imeRef = useRef(ime);
  imeRef.current = ime;
  const compositionRangeRef = useRef<{ from: number; to: number } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bundleRef = useRef<CodeMirrorBundle>({ view: null });
  const baselineRef = useRef<string>(content.text ?? "");
  // 最近一次编辑器全文：切换到预览态时 CodeMirror 被销毁，
  // 挂起的自动保存从这里取文本，避免误写旧基线丢改动。
  const lastTextRef = useRef<string>(content.text ?? "");
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
    if (!host || viewMode !== "source") return;
    let disposed = false;
    let view: import("@codemirror/view").EditorView | null = null;
    void (async () => {
      try {
        const [
          { EditorView, keymap, drawSelection, highlightActiveLine },
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
              history(),
              drawSelection(),
              highlightActiveLine(),
              EditorView.lineWrapping,
              EditorView.contentAttributes.of(
                imeEditorAttributes({ targetId: "workspace-markdown-editor" }),
              ),
              markdown(),
              codeMirrorImeCompositionField,
              syntaxHighlighting(highlight),
              keymap.of([...defaultKeymap, ...historyKeymap]),
              EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                setDirtyState(true);
              }),
              // 粘贴图片：拦截剪贴板图片文件，落盘 assets/ 并插入相对链接。
              EditorView.domEventHandlers({
                keydown: (event, editor) => {
                  if (
                    handleImeEditorKeyDown({
                      event,
                      policy: imeRef.current.textPolicy,
                      readSelection: () => {
                        const selection = editor.state.selection.main;
                        return { start: selection.from, end: selection.to };
                      },
                      onCaptureCompositionStart: (range) => {
                        compositionRangeRef.current = { from: range.start, to: range.end };
                      },
                      sendKey: (keyEvent, apply) => imeRef.current.sendKey(keyEvent, false, apply),
                      applyEditorCommand: (command) => {
                        if (bundleRef.current.view === editor)
                          applyCodeMirrorImeCommand(editor, command);
                      },
                    })
                  )
                    return true;
                  if (
                    imeRef.current.targetEngaged &&
                    !imeRef.current.state.composing &&
                    event.key === "Enter" &&
                    !event.ctrlKey &&
                    !event.altKey &&
                    !event.metaKey
                  ) {
                    createCodeMirrorTextAdapter(editor).insertText("\n");
                    return true;
                  }
                  return false;
                },
                beforeinput: (event) => {
                  if (imeRef.current.shouldPreventBeforeInput(event.inputType)) {
                    event.preventDefault();
                    return true;
                  }
                  return false;
                },
                compositionstart: (event) => {
                  if (!imeRef.current.textPolicy.blockComposition) return false;
                  event.preventDefault();
                  return true;
                },
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
        view.contentDOM.addEventListener("focus", onEditorFocus);
        view.contentDOM.addEventListener("blur", onEditorBlur);
        if (document.activeElement === view.contentDOM) void imeRef.current.acquire();
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "编辑器加载失败");
      }
    })();
    return () => {
      disposed = true;
      // 销毁前捕获最终文本：预览态没有编辑器实例，挂起的自动保存依赖它。
      if (view) lastTextRef.current = view.state.doc.toString();
      view?.contentDOM.removeEventListener("focus", onEditorFocus);
      view?.contentDOM.removeEventListener("blur", onEditorBlur);
      void imeRef.current.release("editor-unmount");
      view?.destroy();
      bundleRef.current.view = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, viewMode, setDirtyState]);

  useEffect(() => {
    const view = bundleRef.current.view;
    const range = compositionRangeRef.current;
    if (!view) return;
    if (!ime.state.composing || !ime.state.preedit || !range) {
      setCodeMirrorImeComposition(view, null);
      if (!ime.state.composing) compositionRangeRef.current = null;
      return;
    }
    setCodeMirrorImeComposition(view, {
      ...range,
      preedit: ime.state.preedit,
      targetId: "workspace-markdown-editor",
    });
  }, [ime.state.composing, ime.state.preedit]);

  function onEditorFocus() {
    void imeRef.current.acquire();
  }

  function onEditorBlur() {
    imeRef.current.blur();
  }

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
      createCodeMirrorTextAdapter(editor).insertText(`![](assets/${name})\n`);
      setDirtyState(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片保存失败");
    }
  }

  // 文件切换：重置基线。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在文件切换时重置基线；content.text 为该文件的打开快照。
  useEffect(() => {
    baselineRef.current = content.text ?? "";
    lastTextRef.current = content.text ?? "";
    setDirtyState(false);
    setConflict(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // 外部变更（仅来自主进程确认的非自身写入）：未保存编辑则提示冲突，否则静默重载。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 桥函数按引用稳定，不作为响应依赖；仅监听版本与路径。
  useEffect(() => {
    if (externalVersion === 0) return;
    // 已有未保存编辑：直接提示冲突即可，无需再读盘（读了也会被丢弃）。
    if (dirtyRef.current) {
      setConflict(true);
      return;
    }
    if (!bridge?.readWorkspaceFile) return;
    let cancelled = false;
    void bridge
      .readWorkspaceFile(path)
      .then((fresh) => {
        if (cancelled) return;
        const text = fresh.text ?? "";
        baselineRef.current = text;
        lastTextRef.current = text;
        const view = bundleRef.current.view;
        if (view) {
          const length = view.state.doc.length;
          view.dispatch({
            changes: { from: 0, to: length, insert: text },
            selection: {
              anchor: Math.min(view.state.selection.main.anchor, text.length),
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
    const text = view ? view.state.doc.toString() : lastTextRef.current;
    try {
      await bridge.writeWorkspaceFile(path, text);
      // 主进程已抑制自身写盘产生的 watcher 回声，这里只需更新基线并清除脏标记。
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
      {viewMode === "source" && (
        <ImeCandidateAnchorReporter
          blockNativeEditing={ime.textPolicy.blockNativeEditing}
          generation={ime.generation}
          onUpdate={ime.updateCandidate}
          state={ime.state}
          targetId="workspace-markdown-editor"
        />
      )}
      <div className="workspace-editor__toolbar">
        <div className="workspace-editor__modes" role="tablist" aria-label="视图模式">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "source"}
            className={`workspace-editor__mode${viewMode === "source" ? " workspace-editor__mode--active" : ""}`}
            onClick={() => onViewModeChange("source")}
          >
            源码
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "preview"}
            className={`workspace-editor__mode${viewMode === "preview" ? " workspace-editor__mode--active" : ""}`}
            onClick={() => onViewModeChange("preview")}
          >
            预览
          </button>
        </div>
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
                lastTextRef.current = fresh.text ?? "";
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
      {viewMode === "source" ? (
        <div ref={hostRef} className="workspace-editor__host" />
      ) : (
        <ZoomablePreview className="workspace-preview-markdown-zoom">
          <MarkdownStaticPreview text={baselineRef.current} dir={dir} />
        </ZoomablePreview>
      )}
    </div>
  );
}

/** react-markdown 组件在预览态用到的最小属性面（避免暴露完整 Options 泛型）。 */
interface MarkdownRendererProps {
  children?: string;
  remarkPlugins?: unknown[];
  rehypePlugins?: unknown[];
  components?: {
    img?: (props: { src?: unknown; alt?: unknown }) => ReactNode;
  };
}

/**
 * 预览态：react-markdown + remark-gfm + rehype-raw（渲染内嵌 HTML，如 br/a），
 * rehype-sanitize 兜底白名单；图片走 answra-file 协议。
 */
function MarkdownStaticPreview({ text, dir }: { text: string; dir: string }) {
  const [renderer, setRenderer] = useState<null | ((props: MarkdownRendererProps) => ReactNode)>(
    null,
  );
  const [plugins, setPlugins] = useState<{ remark: unknown[]; rehype: unknown[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      import("react-markdown"),
      import("remark-gfm"),
      import("rehype-raw"),
      import("rehype-sanitize"),
    ]).then(([markdownModule, gfmModule, rawModule, sanitizeModule]) => {
      if (cancelled) return;
      setRenderer(() => markdownModule.default as (props: MarkdownRendererProps) => ReactNode);
      setPlugins({
        remark: [gfmModule.default],
        rehype: [rawModule.default, sanitizeModule.default],
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!renderer || !plugins) return <div className="workspace-preview-status">预览加载中…</div>;
  const ReactMarkdown = renderer;
  return (
    <div className="workspace-preview-markdown">
      <ReactMarkdown
        remarkPlugins={plugins.remark}
        rehypePlugins={plugins.rehype}
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
