/** 输入框选区：以插入点与锚点表达，供编辑、渲染和剪切共用；不依赖 Ink/React。 */

export interface InputSelectionRange {
  readonly start: number;
  readonly end: number;
}

/** 锚点为空或与插入点重合时没有选区。 */
export function selectionRange(
  anchor: number | null,
  cursor: number,
): InputSelectionRange | undefined {
  if (anchor === null || anchor === cursor) return undefined;
  return { start: Math.min(anchor, cursor), end: Math.max(anchor, cursor) };
}

export function selectedText(value: string, selection: InputSelectionRange): string {
  return value.slice(selection.start, selection.end);
}

/** 删除选区并把插入点放到选区起点。 */
export function deleteSelection(
  value: string,
  selection: InputSelectionRange,
): { readonly value: string; readonly cursor: number } {
  return {
    value: value.slice(0, selection.start) + value.slice(selection.end),
    cursor: selection.start,
  };
}
