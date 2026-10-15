import { type Content, type Editor, Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { type RefObject, useEffect, useMemo, useRef } from "react";

const OVERLAY_KEY = new PluginKey("composer-overlay");

interface OverlayState {
  preedit: string;
  placeholder: string;
}

/**
 * 在文档末尾追加 preedit 展示（不进文档内容）、在空文档时显示 placeholder。
 * 两者都是纯装饰，避免编辑器内容与外部 draft 值不一致。
 */
function createOverlayExtension(): Extension {
  return Extension.create({
    name: "composerOverlay",
    addProseMirrorPlugins() {
      return [
        new Plugin<OverlayState>({
          key: OVERLAY_KEY,
          state: {
            init: () => ({ preedit: "", placeholder: "" }),
            apply: (tr, previous) => tr.getMeta(OVERLAY_KEY) ?? previous,
          },
          props: {
            decorations(state) {
              const meta = OVERLAY_KEY.getState(state) as OverlayState | undefined;
              if (!meta) return DecorationSet.empty;
              const decorations: Decoration[] = [];
              const doc = state.doc;
              if (meta.preedit) {
                decorations.push(
                  Decoration.widget(
                    Math.max(0, doc.content.size - 1),
                    () => {
                      const span = document.createElement("span");
                      span.className = "composer-preedit";
                      span.dataset.composerPreedit = "true";
                      span.textContent = meta.preedit;
                      return span;
                    },
                    { side: 10, key: `preedit:${meta.preedit}` },
                  ),
                );
              }
              const isEmpty = doc.childCount === 1 && doc.firstChild?.content.size === 0;
              if (meta.placeholder && isEmpty && !meta.preedit) {
                decorations.push(
                  Decoration.widget(
                    1,
                    () => {
                      const span = document.createElement("span");
                      span.className = "composer-placeholder";
                      span.textContent = meta.placeholder;
                      return span;
                    },
                    { side: 10, key: "placeholder" },
                  ),
                );
              }
              return decorations.length
                ? DecorationSet.create(doc, decorations)
                : DecorationSet.empty;
            },
          },
        }),
      ];
    },
  });
}

export interface RichTextComposerProps {
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** 内置输入法接管中：编辑器不可编辑，按键经 onKeyDown 交由 Rime 处理。 */
  imeBlocked?: boolean;
  imeActive?: boolean;
  /** 拼音 preedit，纯展示，追加在输入内容末尾。 */
  preedit?: string;
  className?: string;
  /** 外部持有编辑器 DOM（具备 focus()），如"引用回复"聚焦。 */
  editorRef?: RefObject<HTMLElement | null>;
  /** 暴露 TipTap 实例（测试或高级宿主使用）。 */
  onEditorReady?: (editor: Editor) => void;
  onValueChange?: (value: string) => void;
  /** 粘贴图片（clipboard 中的 image 文件），返回由宿主决定入库方式。 */
  onPasteImages?: (files: File[]) => void;
}

/**
 * TipTap（ProseMirror）封装的可复用纯文本编辑器：
 * 值模型是纯文本 string（段落以 \n 分隔），支持粘贴图片回调、
 * 嵌入式输入法接管（不可编辑态 + keydown 转发 + preedit 装饰）。
 */
export function RichTextComposer({
  value,
  placeholder = "",
  ariaLabel,
  disabled = false,
  imeBlocked = false,
  imeActive = false,
  preedit = "",
  className,
  editorRef,
  onEditorReady,
  onValueChange,
  onPasteImages,
}: RichTextComposerProps) {
  const onValueChangeRef = useRef(onValueChange);
  useEffect(() => {
    onValueChangeRef.current = onValueChange;
  }, [onValueChange]);

  const overlayExtension = useMemo(createOverlayExtension, []);
  // Keep contenteditable enabled so Chromium renders a real caret; IME input
  // is still intercepted by handleTextInput and the outer key handler.
  const editable = !disabled;

  const editor = useEditor(
    {
      extensions: [Document, Paragraph, Text, HardBreak, overlayExtension],
      content: toContent(value),
      editable,
      editorProps: {
        attributes: {
          class: imeBlocked ? "composer-editor embedded-ime-input" : "composer-editor",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": ariaLabel ?? "",
          ...(imeBlocked ? { "aria-readonly": "true", "data-embedded-ime-target": "true" } : {}),
          ...(imeActive ? { "data-embedded-ime-active": "true" } : {}),
          // 输入法接管期间保持可聚焦，keydown 才能送达 Rime 处理。
          tabindex: "0",
        },
        // Rime 接管时禁止 ProseMirror 写入文本（与 textarea readOnly 等价的双保险）。
        handleTextInput: () => imeBlocked,
        handlePaste: (_view, event) => {
          if (imeBlocked) return true;
          const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (files.length === 0) return false;
          onPasteImages?.(files);
          return true;
        },
      },
      onUpdate: ({ editor: current }) => {
        onValueChangeRef.current?.(current.getText({ blockSeparator: "\n" }));
      },
    },
    [],
  );

  useEffect(() => {
    if (!editor) return;
    onEditorReady?.(editor);
    if (editorRef) editorRef.current = editor.view.dom as HTMLElement;
    return () => {
      if (editorRef?.current === editor.view.dom) editorRef.current = null;
    };
  }, [editor, editorRef, onEditorReady]);

  // 外部值与编辑器内容同步：指纹比对避免无谓的 setContent（会重置选区）。
  useEffect(() => {
    if (!editor) return;
    const current = editor.getText({ blockSeparator: "\n" });
    if (current === value) return;
    editor.commands.setContent(toContent(value), { emitUpdate: false });
  }, [editor, value]);

  // preedit/placeholder 走纯装饰更新，不触碰文档。
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(OVERLAY_KEY, { preedit, placeholder } satisfies OverlayState),
    );
  }, [editor, preedit, placeholder]);

  useEffect(() => editor?.setEditable(!disabled), [editor, disabled]);

  return <EditorContent className={className} editor={editor} />;
}

function toContent(value: string): Content {
  if (value === "") return { type: "doc", content: [{ type: "paragraph" }] };
  return {
    type: "doc",
    content: value.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : undefined,
    })),
  };
}
