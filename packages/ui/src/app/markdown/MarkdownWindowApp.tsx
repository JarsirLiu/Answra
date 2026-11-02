import type { DesktopBridge, MarkdownDocument } from "@answra/shared";
import { Check, Code2, Eye, FilePlus2, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LazyMarkdownRuntime } from "../../components/markdown/LazyMarkdownRuntime";
import "./MarkdownWindowApp.css";

export function MarkdownWindowApp({ bridge }: { bridge: DesktopBridge | undefined }) {
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const editorHost = useRef<HTMLDivElement>(null);
  const editorView = useRef<import("@codemirror/view").EditorView | null>(null);
  const revision = useRef(0);
  const savedText = useRef("");
  const textRef = useRef("");
  const dirtyRef = useRef(false);
  const saveQueue = useRef(Promise.resolve());
  dirtyRef.current = dirty;
  useEffect(() => {
    let active = true;
    if (bridge?.markdownGetDocument)
      void bridge
        .markdownGetDocument()
        .then((value) => {
          if (!active) return;
          setDocument(value);
          savedText.current = value.text;
          textRef.current = value.text;
          setText(value.text);
        })
        .catch((cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : "打开失败");
        });
    const unsubscribe = bridge?.onMarkdownChanged?.(() => {
      if (textRef.current !== savedText.current) {
        setConflict(true);
        return;
      }
      const observedRevision = revision.current;
      void bridge
        .markdownGetDocument?.()
        .then((fresh) => {
          if (!active) return;
          if (revision.current !== observedRevision) {
            setConflict(true);
            return;
          }
          savedText.current = fresh.text;
          textRef.current = fresh.text;
          setText(fresh.text);
          if (editorView.current)
            editorView.current.dispatch({
              changes: { from: 0, to: editorView.current.state.doc.length, insert: fresh.text },
            });
        })
        .catch((cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : "重新载入失败");
        });
    });
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      unsubscribe?.();
      active = false;
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [bridge]);
  const save = useCallback(async () => {
    if (!bridge?.markdownSaveDocument) return;
    const savedRevision = revision.current;
    const snapshot = textRef.current;
    try {
      const operation = saveQueue.current.then(() => bridge.markdownSaveDocument?.(snapshot));
      saveQueue.current = operation.then(
        () => undefined,
        () => undefined,
      );
      await operation;
      savedText.current = snapshot;
      if (revision.current === savedRevision) setDirty(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    }
  }, [bridge]);
  useEffect(() => {
    if (preview || !document || !editorHost.current) return;
    let disposed = false;
    void (async () => {
      const [
        { EditorView, keymap },
        { defaultKeymap, history, historyKeymap },
        { markdown },
        { EditorState },
      ] = await Promise.all([
        import("@codemirror/view"),
        import("@codemirror/commands"),
        import("@codemirror/lang-markdown"),
        import("@codemirror/state"),
      ]);
      if (disposed || !editorHost.current) return;
      const view = new EditorView({
        parent: editorHost.current,
        state: EditorState.create({
          doc: textRef.current,
          extensions: [
            history(),
            markdown(),
            EditorView.lineWrapping,
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              textRef.current = update.state.doc.toString();
              revision.current += 1;
              setText(textRef.current);
              setDirty(textRef.current !== savedText.current);
            }),
          ],
        }),
      });
      editorView.current = view;
      setEditorReady(true);
    })().catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : "编辑器加载失败");
    });
    return () => {
      disposed = true;
      editorView.current?.destroy();
      editorView.current = null;
      setEditorReady(false);
    };
  }, [document, preview]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        editorView.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);
  if (!document)
    return (
      <main className="markdown-window">
        <p>{error ?? "正在打开文档…"}</p>
      </main>
    );
  return (
    <main className="markdown-window">
      <header className="markdown-window__toolbar">
        <div className="markdown-window__file">
          <strong>{document.name}</strong>
          <small>{document.path}</small>
        </div>
        <span className={`markdown-window__status ${dirty ? "is-dirty" : "is-saved"}`}>
          {dirty ? (
            "未保存"
          ) : (
            <>
              <Check size={14} /> 已保存
            </>
          )}
        </span>
        <button
          type="button"
          aria-label="打开 Markdown 文件"
          title="打开文件"
          onClick={() => void bridge?.markdownOpenDocument?.()}
        >
          <FilePlus2 size={16} />
        </button>
        <button
          type="button"
          aria-label="保存 Markdown 文件"
          title="保存 (Ctrl+S)"
          onClick={() => void save()}
        >
          <Save size={16} />
        </button>
        <div className="markdown-window__modes" role="toolbar" aria-label="编辑模式">
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
            <Code2 size={15} /> 源码
          </button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
            <Eye size={15} /> 预览
          </button>
        </div>
      </header>
      {error && <div className="markdown-window__error">{error}</div>}
      {conflict && (
        <div className="markdown-window__conflict">
          文件已在其他程序中修改。
          <button type="button" onClick={() => void save()}>
            保留本地版本
          </button>
          <button
            type="button"
            onClick={() => {
              void bridge
                ?.markdownGetDocument?.()
                .then((fresh) => {
                  savedText.current = fresh.text;
                  textRef.current = fresh.text;
                  setText(fresh.text);
                  setDirty(false);
                  setConflict(false);
                  if (editorView.current)
                    editorView.current.dispatch({
                      changes: {
                        from: 0,
                        to: editorView.current.state.doc.length,
                        insert: fresh.text,
                      },
                    });
                })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : "重新载入失败"),
                );
            }}
          >
            重新载入磁盘版本
          </button>
        </div>
      )}
      {preview ? (
        <MarkdownPreview bridge={bridge} text={text} />
      ) : (
        <div className="markdown-window__editor">
          <div ref={editorHost} className="markdown-window__editor-host" />
          {!editorReady && <div className="markdown-window__loading">编辑器加载中…</div>}
        </div>
      )}
    </main>
  );
}

function MarkdownPreview({ bridge, text }: { bridge: DesktopBridge | undefined; text: string }) {
  return (
    <article className="markdown-window__preview">
      <LazyMarkdownRuntime
        mode="safe-preview"
        fallback={<div className="markdown-window__preview-status">预览加载中…</div>}
        components={{
          img: ({ src, alt, title }) => (
            <MarkdownImage bridge={bridge} src={src} alt={alt} title={title} />
          ),
        }}
      >
        {text}
      </LazyMarkdownRuntime>
    </article>
  );
}

function MarkdownImage({
  bridge,
  src,
  alt,
  title,
}: {
  bridge: DesktopBridge | undefined;
  src: unknown;
  alt: unknown;
  title: unknown;
}) {
  const source = typeof src === "string" ? src : "";
  const [resolvedSource, setResolvedSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    if (/^(https?:\/\/|data:image\/)/i.test(source)) {
      setResolvedSource(source);
      return () => {
        active = false;
      };
    }
    setResolvedSource(null);
    if (!source || !bridge?.markdownResolveImage) {
      setFailed(true);
      return () => {
        active = false;
      };
    }
    void bridge
      .markdownResolveImage(source)
      .then((dataUrl) => {
        if (active) setResolvedSource(dataUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [bridge, source]);
  const altText = typeof alt === "string" ? alt : "";
  if (failed)
    return (
      <span className="markdown-window__image-error" role="status">
        {altText ? `${altText}：图片无法显示` : "图片无法显示"}
      </span>
    );
  if (!resolvedSource)
    return (
      <span className="markdown-window__image-loading" role="status">
        {altText ? `${altText}：图片加载中…` : "图片加载中…"}
      </span>
    );
  return (
    <img
      src={resolvedSource}
      alt={altText}
      title={typeof title === "string" ? title : undefined}
      loading="lazy"
    />
  );
}
