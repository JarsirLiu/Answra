/** TUI 投影 state：snapshot 初始化、事件批量归并和 run 阶段；不碰终端 I/O。 */
import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import {
  applyAgentEvent,
  applyConversationSnapshot,
  type ConversationView,
  EMPTY_CONVERSATION_VIEW,
} from "@answra/ui/conversation-view";

const TUI_EVENT_BATCH_MS = 16;
const TUI_EVENT_QUEUE_MAX = 2_048;

export type TuiRunPhase = "idle" | "running" | "cancelling";

export interface TuiState {
  view: ConversationView;
  phase: TuiRunPhase;
  queued: number;
  localError?: string;
  notice?: readonly string[];
}

type Listener = () => void;

/** 单一 writer：snapshot 与事件都只经过这里更新 TUI state。 */
export class TuiViewStore {
  private state: TuiState = {
    view: EMPTY_CONVERSATION_VIEW,
    phase: "idle",
    queued: 0,
  };
  private readonly listeners = new Set<Listener>();
  private pending: AgentEventEnvelope[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): TuiState => this.state;

  initialize(snapshot: ConversationSnapshot): void {
    this.flush();
    if (snapshot.eventRevision < this.state.view.eventRevision) return;
    this.setState({
      ...this.state,
      view: applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, snapshot),
      localError: undefined,
    });
  }

  applySnapshot(snapshot: ConversationSnapshot): void {
    if (this.disposed) return;
    this.flush();
    if (snapshot.eventRevision < this.state.view.eventRevision) return;
    this.setState({
      ...this.state,
      view: applyConversationSnapshot(this.state.view, snapshot),
      localError: undefined,
    });
  }

  applyEvent(envelope: AgentEventEnvelope): void {
    if (this.disposed) return;
    this.pending.push(envelope);
    if (this.pending.length >= TUI_EVENT_QUEUE_MAX) {
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  /** `/clear` 后以空视图重建，避免旧 transcript 通过 snapshot 合并规则残留。 */
  reset(snapshot: ConversationSnapshot): void {
    if (this.disposed) return;
    this.flush();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
    this.setState({
      ...this.state,
      view: applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, snapshot),
      queued: 0,
      localError: undefined,
      notice: undefined,
    });
  }

  setQueued(count: number): void {
    if (this.state.queued === count) return;
    this.setState({ ...this.state, queued: count });
  }

  setNotice(lines: readonly string[] | undefined): void {
    this.setState({ ...this.state, notice: lines });
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const pending = this.pending;
    this.pending = [];
    let view = this.state.view;
    for (const envelope of pending) view = applyAgentEvent(view, envelope);
    if (view === this.state.view) return;
    this.setState({ ...this.state, view });
  }

  beginRun(): void {
    this.flush();
    this.setState({ ...this.state, phase: "running", localError: undefined, notice: undefined });
  }

  markCancelling(): void {
    this.setState({ ...this.state, phase: "cancelling" });
  }

  finishRun(): void {
    this.flush();
    this.setState({ ...this.state, phase: "idle" });
  }

  fail(message: string): void {
    this.flush();
    this.setState({ ...this.state, localError: message });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.listeners.clear();
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, TUI_EVENT_BATCH_MS);
  }

  private setState(next: TuiState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
