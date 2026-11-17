/**
 * 可选中文本行：用一个 ink-text host 取得绝对行列并登记可见文本；
 * 选区覆盖时在输出阶段插入反色。样式仍交给内部 <Text>，不改变布局。
 */
import { type DOMElement, Text } from "ink";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { highlightSelection, selectionRowRange, stripAnsi } from "../interaction/selection";
import type { TuiSelectionStore } from "../interaction/selectionStore";

const HOST_STYLE = {
  flexDirection: "row",
  flexGrow: 0,
  flexShrink: 1,
  textWrap: "wrap",
} as const;

const NO_SUBSCRIBE = () => () => {};

export const SelectionContext = createContext<TuiSelectionStore | undefined>(undefined);

export interface SelectableTextProps {
  readonly children?: ReactNode;
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly dimColor?: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly inverse?: boolean;
}

export function SelectableText({ children, ...style }: SelectableTextProps) {
  const store = useContext(SelectionContext);
  useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, store?.getVersion ?? getZero);
  if (store === undefined) return <Text {...style}>{children}</Text>;
  return (
    <SelectableLine store={store} style={style}>
      {children}
    </SelectableLine>
  );
}

function SelectableLine({
  store,
  style,
  children,
}: {
  store: TuiSelectionStore;
  style: Omit<SelectableTextProps, "children">;
  children?: ReactNode;
}) {
  const nodeRef = useRef<DOMElement>(null);
  const [mounted, setMounted] = useState(false);

  useLayoutEffect(() => {
    if (!mounted && nodeRef.current !== null) setMounted(true);
  }, [mounted]);

  const transform = useCallback(
    (text: string, lineIndex: number): string => {
      const node = nodeRef.current;
      if (!mounted || node === null) return text;
      const position = absolutePosition(node);
      const plain = stripAnsi(text);
      const contentRow = store.registerLine({
        row: position.row + lineIndex,
        left: position.col,
        text: plain,
      });
      const bounds = store.getBounds();
      if (bounds === undefined) return text;
      const range = selectionRowRange(bounds, {
        row: contentRow,
        left: position.col,
        text: plain,
      });
      if (range === undefined) return text;
      return highlightSelection(text, range.from, range.to);
    },
    [mounted, store],
  );

  return createElement(
    "ink-text",
    { internal_transform: transform, ref: nodeRef, style: HOST_STYLE },
    createElement(Text, style, children),
  );
}

function absolutePosition(node: DOMElement): { row: number; col: number } {
  let row = 0;
  let col = 0;
  let current: DOMElement | undefined = node;
  while (current !== undefined) {
    if (current.yogaNode !== undefined) {
      row += current.yogaNode.getComputedTop();
      col += current.yogaNode.getComputedLeft();
    }
    const parent: DOMElement | undefined = current.parentNode;
    if (parent !== undefined) {
      row -= offsetFor(parent.style.contentOffsetY);
      col -= offsetFor(parent.style.contentOffsetX);
    }
    current = parent;
  }
  return { row, col };
}

function offsetFor(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function getZero(): number {
  return 0;
}
