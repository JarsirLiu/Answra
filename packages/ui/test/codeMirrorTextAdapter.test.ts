import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCodeMirrorImeCommand,
  codeMirrorImeCompositionField,
  createCodeMirrorTextAdapter,
  setCodeMirrorImeComposition,
} from "../src/ime/adapters/codeMirrorTextAdapter";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe("CodeMirror text adapter", () => {
  it("replaces the selected range, moves selection, and keeps the edit undoable", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "hello world",
        selection: { anchor: 6, head: 11 },
        extensions: [history(), codeMirrorImeCompositionField],
      }),
    });

    createCodeMirrorTextAdapter(view).insertText("Answra");

    expect(view.state.doc.toString()).toBe("hello Answra");
    expect(view.state.selection.main.head).toBe(12);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("hello world");
  });

  it("applies a commit and editor command after CodeMirror loses DOM focus", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "hello world",
        selection: { anchor: 6, head: 11 },
        extensions: [history(), codeMirrorImeCompositionField],
      }),
    });

    view.contentDOM.focus();
    expect(view.hasFocus).toBe(true);
    view.contentDOM.blur();
    expect(view.hasFocus).toBe(false);

    createCodeMirrorTextAdapter(view).insertText("你好");
    expect(view.state.doc.toString()).toBe("hello 你好");
    expect(view.state.selection.main.head).toBe(8);

    applyCodeMirrorImeCommand(view, {
      type: "moveCaret",
      direction: "left",
      extend: false,
    });
    expect(view.state.selection.main.head).toBe(7);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("hello world");
  });

  it("applies editor fallback commands without routing them back through the browser", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "abcd", selection: { anchor: 2 } }),
    });
    applyCodeMirrorImeCommand(view, { type: "deleteBackward" });
    expect(view.state.doc.toString()).toBe("acd");
    applyCodeMirrorImeCommand(view, { type: "moveCaret", direction: "right", extend: false });
    expect(view.state.selection.main.head).toBe(2);
  });

  it("projects composition with a mapped bookmark without changing the document", () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "abcd",
        selection: { anchor: 1, head: 3 },
        extensions: [codeMirrorImeCompositionField],
      }),
    });

    setCodeMirrorImeComposition(view, {
      from: 1,
      to: 3,
      preedit: "ni",
      targetId: "workspace-editor",
    });

    expect(view.state.doc.toString()).toBe("abcd");
    expect(
      view.dom.querySelector("[data-ime-composition-target='workspace-editor']")?.textContent,
    ).toBe("ni");
    expect(view.dom.querySelector("[data-ime-composition-caret='true']")).not.toBeNull();

    view.dispatch({ changes: { from: 0, insert: "x" } });
    setCodeMirrorImeComposition(view, {
      from: 1,
      to: 3,
      preedit: "nihao",
      targetId: "workspace-editor",
    });
    expect(view.state.doc.toString()).toBe("xabcd");
    expect(
      view.dom.querySelector("[data-ime-composition-target='workspace-editor']")?.textContent,
    ).toBe("nihao");
  });
});
