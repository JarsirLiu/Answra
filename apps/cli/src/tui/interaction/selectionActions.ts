/** 指针与快捷键到选区/复制的唯一编排；store 仍是唯一 writer，组合根只接线。 */
import type { ClipboardWriter } from "./clipboard";
import type { PointerEvent } from "./pointerInput";
import type { TuiSelectionStore } from "./selectionStore";

export interface SelectionActions {
  handlePointer(event: PointerEvent): void;
  copy(): void;
  selectAllAndCopy(): void;
  clear(): void;
}

export function createSelectionActions(
  store: TuiSelectionStore,
  clipboard: ClipboardWriter,
): SelectionActions {
  const copy = (): void => {
    const text = store.getSelectedText();
    if (text.length > 0) clipboard.write(text);
  };

  return {
    handlePointer(event) {
      switch (event.kind) {
        case "wheel":
          return;
        case "press":
          if (store.hasLine(event.point.row)) store.begin(event.point);
          else store.clear();
          return;
        case "drag":
          store.extend(event.point);
          return;
        case "release":
          store.extend(event.point);
          copy();
      }
    },
    copy,
    selectAllAndCopy() {
      store.selectAll();
      copy();
    },
    clear() {
      store.clear();
    },
  };
}
