import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeMirrorTextAdapter } from "../src/ime/adapters/codeMirrorTextAdapter";

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
        extensions: [history()],
      }),
    });

    createCodeMirrorTextAdapter(view).insertText("Answra");

    expect(view.state.doc.toString()).toBe("hello Answra");
    expect(view.state.selection.main.head).toBe(12);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("hello world");
  });
});
