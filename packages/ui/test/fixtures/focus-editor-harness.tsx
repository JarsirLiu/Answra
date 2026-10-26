import type { ImeCandidateUpdate, ImeState } from "@answra/shared";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ImeCandidateAnchorReporter } from "../../src/components/panels/ImeCandidateAnchorReporter";
import { createCodeMirrorTextAdapter } from "../../src/ime/adapters/codeMirrorTextAdapter";
import { useControlledImeTextAdapter } from "../../src/ime/adapters/useControlledImeTextAdapter";

const editorState: ImeState = {
  enabled: true,
  inputMode: "chinese",
  composing: false,
  preedit: "",
  candidates: [{ text: "你好" }],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

function Harness() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const codeMirrorHostRef = useRef<HTMLDivElement>(null);
  const codeMirrorRef = useRef<EditorView | null>(null);
  const anchorUpdatesRef = useRef<ImeCandidateUpdate[]>([]);
  const [textareaValue, setTextareaValue] = useState("alpha beta gamma");
  const [report, setReport] = useState({
    title: "等待测试",
    details: ["选择一项测试后，结果会显示在这里。"],
  });
  const [windowState, setWindowState] = useState({
    focused: document.hasFocus(),
    visible: document.visibilityState,
  });
  const [windowEvents, setWindowEvents] = useState<Array<{ id: number; label: string }>>([]);
  const textareaAdapter = useControlledImeTextAdapter({
    inputRef: textareaRef,
    value: textareaValue,
    onChange: setTextareaValue,
  });

  function recordAnchorUpdate(update: ImeCandidateUpdate) {
    anchorUpdatesRef.current.push(update);
    (
      window as Window & { __focusHarnessAnchorUpdates?: ImeCandidateUpdate[] }
    ).__focusHarnessAnchorUpdates = anchorUpdatesRef.current;
  }

  useLayoutEffect(() => {
    const host = codeMirrorHostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "alpha beta gamma",
        selection: { anchor: 6, head: 10 },
        extensions: [history()],
      }),
    });
    codeMirrorRef.current = view;
    return () => {
      codeMirrorRef.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const events: string[] = [];
    const record = (event: string) => {
      setWindowState({ focused: document.hasFocus(), visible: document.visibilityState });
      const eventName =
        event === "visibilitychange"
          ? "页面可见性变化"
          : `窗口${event === "focus" ? "获焦" : "失焦"}`;
      const focusState = document.hasFocus() ? "窗口已获焦" : "窗口未获焦";
      const visibilityState = document.visibilityState === "visible" ? "页面可见" : "页面隐藏";
      events.unshift(`${eventName} · ${focusState} · ${visibilityState}`);
      setWindowEvents(events.map((label, index) => ({ id: index, label })));
      (window as Window & { __focusHarnessWindowEvents?: string[] }).__focusHarnessWindowEvents =
        events;
    };
    const onFocus = () => record("focus");
    const onBlur = () => record("blur");
    const onVisibilityChange = () => record("visibilitychange");
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  function runTextareaFocus() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(6, 10);
    textareaAdapter.captureCompositionStart({ start: 6, end: 10 }, false);
    const bounds = rectSummary(textarea.getBoundingClientRect());
    setReport({
      title: "Textarea 已获焦，组合选区已保存",
      details: [
        `活动元素：${document.activeElement?.tagName ?? "无"}`,
        `选区：${textarea.selectionStart}–${textarea.selectionEnd}`,
        `输入框位置：x ${Math.round(bounds.x)}，y ${Math.round(bounds.y)}`,
        "现在可以切换焦点，再运行“失焦后提交”检查文本和光标。",
      ],
    });
  }

  function runTextareaBlurCommit() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.blur();
    textareaAdapter.commit("你好");
    setReport({
      title: "Textarea 失焦提交完成",
      details: [
        `文本：${textareaValue.replace("beta", "你好")}`,
        "预期光标位置：8",
        `候选锚点更新：${anchorUpdatesRef.current.length} 条（自动化检查使用）`,
      ],
    });
  }

  function runCodeMirrorBlurCommit() {
    const view = codeMirrorRef.current;
    if (!view) return;
    view.focus();
    view.dispatch({ selection: { anchor: 6, head: 10 } });
    view.contentDOM.blur();
    createCodeMirrorTextAdapter(view).insertText("你好");
    const afterCommit = {
      focusedAfterBlur: view.hasFocus,
      text: view.state.doc.toString(),
      caret: view.state.selection.main.head,
      undoAvailable: undo(view),
      textAfterUndo: view.state.doc.toString(),
    };
    setReport({
      title: "CodeMirror 失焦提交与撤销完成",
      details: [
        `失焦后仍保持失焦：${afterCommit.focusedAfterBlur ? "否" : "是"}`,
        `提交结果：${afterCommit.text}`,
        `提交后光标：${afterCommit.caret}`,
        `撤销可用：${afterCommit.undoAvailable ? "是" : "否"}`,
        `撤销后文本：${afterCommit.textAfterUndo}`,
      ],
    });
  }

  function runTextInsertionAfterRefocus() {
    const target = document.createElement("textarea");
    target.value = "paste target";
    document.body.append(target);
    target.focus();
    target.setSelectionRange(6, 6);
    target.setRangeText(" pasted", 6, 6, "end");
    setReport({
      title: "重新获焦后的文本插入完成",
      details: [
        `插入时目标已获焦：${document.activeElement === target ? "是" : "否"}`,
        `文本：${target.value}`,
        `插入后光标：${target.selectionStart}`,
        "此项验证文本插入，不代表真实系统剪贴板粘贴。",
      ],
    });
    target.remove();
  }

  return (
    <main className="page">
      <header>
        <p className="eyebrow">P2-B · 隔离验证</p>
        <h1>输入焦点测试</h1>
        <p className="intro">
          检查输入框失去焦点后，组合文本是否仍能正确提交，以及光标和撤销是否正常。此页面只用于验证，不会修改正式输入行为。
        </p>
      </header>
      <section aria-labelledby="textarea-heading">
        <h2 id="textarea-heading">Textarea</h2>
        <label>
          测试文本
          <textarea
            ref={textareaRef}
            data-ime-policy="text"
            data-ime-target-id="focus-harness-textarea"
            value={textareaValue}
            onChange={(event) => setTextareaValue(event.currentTarget.value)}
            style={{ display: "block", font: "16px/24px sans-serif", height: 72, width: "100%" }}
          />
        </label>
        <ImeCandidateAnchorReporter
          state={editorState}
          targetId="focus-harness-textarea"
          generation={1}
          blockNativeEditing
          onUpdate={recordAnchorUpdate}
        />
      </section>
      <section aria-labelledby="codemirror-heading">
        <h2 id="codemirror-heading">CodeMirror</h2>
        <div ref={codeMirrorHostRef} />
      </section>
      <section aria-labelledby="actions-heading">
        <h2 id="actions-heading">验证操作</h2>
        <nav aria-label="验证操作">
          <button onClick={runTextareaFocus} type="button">
            保存 Textarea 选区
          </button>
          <button onClick={runTextareaBlurCommit} type="button">
            Textarea 失焦后提交
          </button>
          <button onClick={runCodeMirrorBlurCommit} type="button">
            CodeMirror 提交并撤销
          </button>
          <button onClick={runTextInsertionAfterRefocus} type="button">
            重新获焦后插入文本
          </button>
        </nav>
      </section>
      <section aria-labelledby="window-heading">
        <h2 id="window-heading">窗口状态</h2>
        <p id="window-state" role="status">
          {windowState.focused ? "窗口已获焦" : "窗口未获焦"} ·{" "}
          {windowState.visible === "visible" ? "页面可见" : "页面隐藏"}
        </p>
        <ol id="window-events">
          {windowEvents.map((event) => (
            <li key={event.id}>{event.label}</li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="results-heading" aria-live="polite" className="results">
        <h2 id="results-heading">测试结果</h2>
        <h3>{report.title}</h3>
        <ul id="results">
          {report.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function rectSummary(rect: DOMRect) {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

const root = document.querySelector("#root");
if (!root) throw new Error("Focus harness root element is missing");
createRoot(root).render(<Harness />);
