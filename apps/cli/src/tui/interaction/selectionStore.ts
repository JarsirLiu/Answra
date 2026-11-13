/** TUI 选区与已渲染行登记的唯一 writer：渲染期登记，选区变化才通知订阅者。 */
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

export class TuiSelectionStore {
  private anchor: SelectionPoint | undefined;
  private focus: SelectionPoint | undefined;
  private pending = new Map<number, RenderedLine>();
  private committed = new Map<number, RenderedLine>();
  private version = 0;
  private readonly listeners = new Set<Listener>();

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getVersion = (): number => this.version;

  /** 渲染期由 SelectableText 调用，不触发 React 更新。 */
  registerLine(line: RenderedLine): void {
    this.pending.set(line.row, line);
  }

  /** 一帧输出完成后由 Ink onRender 调用，把本帧行登记切换为可复制快照。 */
  commitFrame(): void {
    this.committed = this.pending;
    this.pending = new Map();
  }

  hasLine(row: number): boolean {
    return this.committed.has(row);
  }

  begin(point: SelectionPoint): void {
    this.anchor = point;
    this.focus = point;
    this.notify();
  }

  extend(point: SelectionPoint): void {
    if (this.anchor === undefined) return;
    if (this.focus !== undefined && compareSelectionPoints(this.focus, point) === 0) return;
    this.focus = point;
    this.notify();
  }

  clear(): void {
    if (!this.hasSelection()) return;
    this.anchor = undefined;
    this.focus = undefined;
    this.notify();
  }

  selectAll(): void {
    const bounds = selectAllBounds(this.committed);
    if (bounds === undefined) return;
    this.anchor = bounds.start;
    this.focus = bounds.end;
    this.notify();
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
    return extractSelectionText(bounds, this.committed);
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
