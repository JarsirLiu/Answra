import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineDown,
  cursorLineUp,
  cursorPageDown,
  cursorPageUp,
  deleteCharBackward,
  deleteCharForward,
  selectCharLeft,
  selectCharRight,
  selectLineDown,
  selectLineUp,
  selectPageDown,
  selectPageUp,
} from "@codemirror/commands";
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { ImeEditorCommand } from "../imeKeyRouter";

interface CompositionProjection {
  from: number;
  to: number;
  preedit: string;
  targetId: string;
}

const setCompositionProjection = StateEffect.define<CompositionProjection | null>();

interface CompositionFieldState {
  projection: CompositionProjection | null;
  decorations: DecorationSet;
}

class CompositionWidget extends WidgetType {
  constructor(
    private readonly preedit: string,
    private readonly targetId: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const projection = document.createElement("span");
    projection.dataset.imeCompositionProjection = "true";
    projection.dataset.imeCompositionTarget = this.targetId;
    projection.className = "ime-composition-preedit";
    projection.textContent = this.preedit;
    const caret = document.createElement("span");
    caret.dataset.imeCompositionCaret = "true";
    caret.className = "ime-composition-caret";
    projection.append(caret);
    return projection;
  }

  eq(other: CompositionWidget): boolean {
    return this.preedit === other.preedit && this.targetId === other.targetId;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export const codeMirrorImeCompositionField = StateField.define<CompositionFieldState>({
  create: () => ({ projection: null, decorations: Decoration.none }),
  update(value, transaction) {
    let projection = value.projection
      ? {
          ...value.projection,
          from: transaction.changes.mapPos(value.projection.from, -1),
          to: transaction.changes.mapPos(value.projection.to, 1),
        }
      : null;
    for (const effect of transaction.effects) {
      if (!effect.is(setCompositionProjection)) continue;
      projection = effect.value;
    }
    const decorations = projection
      ? Decoration.set(
          Decoration.replace({
            widget: new CompositionWidget(projection.preedit, projection.targetId),
            inclusive: true,
          }).range(projection.from, projection.to),
        )
      : Decoration.none;
    return { projection, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function setCodeMirrorImeComposition(
  view: EditorView,
  projection: CompositionProjection | null,
): void {
  const current = view.state.field(codeMirrorImeCompositionField).projection;
  const range =
    projection && current?.targetId === projection.targetId
      ? { from: current.from, to: current.to }
      : projection;
  const nextProjection =
    projection && range
      ? {
          ...range,
          preedit: projection.preedit,
          targetId: projection.targetId,
          from: Math.max(0, Math.min(range.from, view.state.doc.length)),
          to: Math.max(0, Math.min(range.to, view.state.doc.length)),
        }
      : null;
  view.dispatch({
    effects: setCompositionProjection.of(nextProjection),
  });
}

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

export function applyCodeMirrorImeCommand(view: EditorView, command: ImeEditorCommand): void {
  if (command.type === "deleteBackward") {
    deleteCharBackward(view);
    return;
  }
  if (command.type === "deleteForward") {
    deleteCharForward(view);
    return;
  }
  const commands = {
    left: command.extend ? selectCharLeft : cursorCharLeft,
    right: command.extend ? selectCharRight : cursorCharRight,
    up: command.extend ? selectLineUp : cursorLineUp,
    down: command.extend ? selectLineDown : cursorLineDown,
    pageUp: command.extend ? selectPageUp : cursorPageUp,
    pageDown: command.extend ? selectPageDown : cursorPageDown,
  };
  commands[command.direction](view);
}
