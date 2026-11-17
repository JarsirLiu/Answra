/**
 * TUI 选区与已渲染行登记的唯一 writer：选区用内容行保存，屏幕行只在指针/渲染边界换算。
 * 缓存保留滚出视口的行文本，使滚动后仍能复制完整选区。
 */
import {
  compareSelectionPoints,
  extractSelectionText,
  orderSelection,
  type RenderedLine,
  type SelectionBounds,
  type SelectionPoint,
  selectAllBounds,
} from "./selection";

type Listener = () => void;

export interface SelectionViewport {
  /** 终端中 transcript 视口第一行的屏幕行号（不含祖先偏移时通常为 0）。 */
  readonly topRow: number;
  /** transcript 视口高度（行）。 */
  readonly height: number;
  /** 视口顶部对应的内容行号，等价于 scrollTop。 */
  readonly offsetRows: number;
}

const EMPTY_VIEWPORT: SelectionViewport = { topRow: 0, height: 0, offsetRows: 0 };

export class TuiSelectionStore {
  private anchor: SelectionPoint | undefined;
  private focus: SelectionPoint | undefined;
  private dragging = false;
  private viewport: SelectionViewport = EMPTY_VIEWPORT;
  private pending = new Map<number, RenderedLine>();
  private visible = new Map<number, RenderedLine>();
  private readonly lines = new Map<number, RenderedLine>();
  private version = 0;
  private readonly listeners = new Set<Listener>();

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getVersion = (): number => this.version;

  /**
   * 由 transcript 视口在渲染期调用；只更新坐标换算，不通知订阅者。
   * 滚动造成的焦点平移由 shiftViewport 负责，避免在 React 渲染中同步通知。
   */
  setViewport(viewport: SelectionViewport): void {
    this.viewport = viewport;
  }

  /** 滚动 delta 行：内容行锚点不动，拖拽中的焦点跟随鼠标保持同一屏幕行。 */
  shiftViewport(delta: number): void {
    if (delta === 0) return;
    this.viewport = {
      ...this.viewport,
      offsetRows: this.viewport.offsetRows + delta,
    };
    if (!this.dragging || this.focus === undefined) return;
    this.focus = { row: this.focus.row + delta, col: this.focus.col };
    this.notify();
  }

  /** 渲染期由 SelectableText 调用，返回该行换算后的内容行号；不触发 React 更新。 */
  registerLine(line: RenderedLine): number {
    const contentRow = this.toContentRow(line.row);
    this.pending.set(contentRow, { ...line, row: contentRow });
    return contentRow;
  }

  /** 一帧输出完成后由 Ink onRender 调用：当前帧行可被点击，同时并入脱屏文本缓存。 */
  commitFrame(): void {
    for (const [row, line] of this.pending) this.lines.set(row, line);
    this.visible = this.pending;
    this.pending = new Map();
  }

  hasLine(screenRow: number): boolean {
    return this.visible.has(this.toContentRow(screenRow));
  }

  begin(point: SelectionPoint): void {
    const content = this.toContentPoint(point);
    this.anchor = content;
    this.focus = content;
    this.dragging = true;
    this.notify();
  }

  extend(point: SelectionPoint): void {
    if (!this.dragging || this.anchor === undefined) return;
    const content = this.toContentPoint(point);
    if (this.focus !== undefined && compareSelectionPoints(this.focus, content) === 0) return;
    this.focus = content;
    this.notify();
  }

  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.notify();
  }

  clear(): void {
    if (!this.hasSelection() && !this.dragging) return;
    this.anchor = undefined;
    this.focus = undefined;
    this.dragging = false;
    this.notify();
  }

  /** 消息结构或布局变化后调用：内容行含义已改变，缓存与选区必须一起失效。 */
  resetContent(): void {
    const hadSelection = this.hasSelection();
    this.anchor = undefined;
    this.focus = undefined;
    this.dragging = false;
    this.pending = new Map();
    this.visible = new Map();
    this.lines.clear();
    if (hadSelection) this.notify();
  }

  selectAll(): void {
    const bounds = selectAllBounds(this.visible);
    if (bounds === undefined) return;
    this.anchor = bounds.start;
    this.focus = bounds.end;
    this.dragging = false;
    this.notify();
  }

  isDragging(): boolean {
    return this.dragging;
  }

  getFocusScreenRow(): number | undefined {
    if (this.focus === undefined) return undefined;
    return this.toScreenRow(this.focus.row);
  }

  getAnchorScreenRow(): number | undefined {
    if (this.anchor === undefined) return undefined;
    return this.toScreenRow(this.anchor.row);
  }

  /** 拖拽焦点越过视口边缘时给出自动滚动方向；焦点必须在锚点的外侧。 */
  dragScrollDirection(topRow: number, bottomRow: number): -1 | 0 | 1 {
    if (!this.dragging) return 0;
    const anchor = this.getAnchorScreenRow();
    const focus = this.getFocusScreenRow();
    if (anchor === undefined || focus === undefined) return 0;
    if (focus <= topRow && anchor > focus) return -1;
    if (focus >= bottomRow && anchor < focus) return 1;
    return 0;
  }

  hasSelection(): boolean {
    return this.getBounds() !== undefined;
  }

  getBounds(): SelectionBounds | undefined {
    return orderSelection(this.anchor, this.focus);
  }

  getSelectedText(): string {
    const bounds = this.getBounds();
    if (bounds === undefined) return "";
    return extractSelectionText(bounds, this.lines);
  }

  private toContentRow(screenRow: number): number {
    return this.viewport.offsetRows + screenRow - this.viewport.topRow;
  }

  private toScreenRow(contentRow: number): number {
    return this.viewport.topRow + contentRow - this.viewport.offsetRows;
  }

  private toContentPoint(point: SelectionPoint): SelectionPoint {
    return { row: this.toContentRow(point.row), col: point.col };
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
