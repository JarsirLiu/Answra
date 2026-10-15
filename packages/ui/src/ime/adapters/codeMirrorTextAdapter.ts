import type { EditorView } from "@codemirror/view";

export interface CodeMirrorTextAdapter {
  insertText(text: string): void;
}

export function createCodeMirrorTextAdapter(view: EditorView): CodeMirrorTextAdapter {
  return {
    insertText(text) {
      view.dispatch(view.state.replaceSelection(text));
    },
  };
}
