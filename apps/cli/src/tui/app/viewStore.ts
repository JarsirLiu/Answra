/** TUI 投影 state：snapshot 初始化、事件批量归并和 run 阶段；不碰终端 I/O。 */
import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import {
  applyAgentEvent,
  applyConversationSnapshot,
  type ConversationView,
  EMPTY_CONVERSATION_VIEW,
} from "@answra/ui/conversation-view";
import type { TuiSetupStep } from "../modelSetup";
import {
  addNotification,
  EMPTY_NOTIFICATION_STATE,
  notificationTimeoutMs,
  promoteNext,
  removeNotification,
  type TuiNotification,
  type TuiNotificationState,
} from "../notices/notification";
import type { TuiPanel } from "../panels/panel";
import type { TuiCompactionBoundary } from "../transcript/compactionBoundary";

const TUI_EVENT_BATCH_MS = 16;
const TUI_EVENT_QUEUE_MAX = 2_048;

export type TuiRunPhase = "idle" | "running" | "cancelling";

export interface TuiState {
  view: ConversationView;
  /** 压缩边界来自 conversation snapshot，只用于 TUI 展示。 */
  compactionBoundaries: readonly TuiCompactionBoundary[];
  /** 手动 `/compact` 正在等待首帧 snapshot；与 run phase 分开。 */
  compactionActive: boolean;
  phase: TuiRunPhase;
  queued: number;
  modelLabel: string;
  modelConfigured: boolean;
  authAvailable: boolean;
  authSignedIn: boolean;
  authAccount?: string;
  setupStep?: TuiSetupStep;
  localError?: string;
  notifications: TuiNotificationState;
  panel?: TuiPanel;
}

type Listener = () => void;

/** 单一 writer：snapshot 与事件都只经过这里更新 TUI state。 */
export class TuiViewStore {
  private state: TuiState = {
    view: EMPTY_CONVERSATION_VIEW,
    compactionBoundaries: [],
    compactionActive: false,
    phase: "idle",
    queued: 0,
    modelLabel: "",
    modelConfigured: false,
    authAvailable: false,
    authSignedIn: false,
    notifications: EMPTY_NOTIFICATION_STATE,
  };
  private readonly listeners = new Set<Listener>();
  private pending: AgentEventEnvelope[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private notificationTimer?: ReturnType<typeof setTimeout>;
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
      compactionBoundaries: boundariesFromSnapshot(snapshot, []),
      compactionActive: false,
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
      compactionBoundaries: boundariesFromSnapshot(snapshot, this.state.compactionBoundaries),
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
    this.clearNotificationTimer();
    this.setState({
      ...this.state,
      view: applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, snapshot),
      compactionBoundaries: [],
      compactionActive: false,
      queued: 0,
      localError: undefined,
      notifications: EMPTY_NOTIFICATION_STATE,
    });
  }

  setQueued(count: number): void {
    if (this.state.queued === count) return;
    this.setState({ ...this.state, queued: count });
  }

  setModelLabel(modelLabel: string): void {
    if (this.state.modelLabel === modelLabel) return;
    this.setState({ ...this.state, modelLabel });
  }

  setModelConfigured(modelConfigured: boolean): void {
    if (this.state.modelConfigured === modelConfigured) return;
    this.setState({ ...this.state, modelConfigured });
  }

  setAuthAvailable(authAvailable: boolean): void {
    if (this.state.authAvailable === authAvailable) return;
    this.setState({ ...this.state, authAvailable });
  }

  setAuthStatus(status: { signedIn: boolean; account: string | null }): void {
    const account = status.account ?? undefined;
    if (this.state.authSignedIn === status.signedIn && this.state.authAccount === account) return;
    this.setState({ ...this.state, authSignedIn: status.signedIn, authAccount: account });
  }

  setSetupStep(setupStep: TuiSetupStep | undefined): void {
    if (this.state.setupStep === setupStep) return;
    this.setState({ ...this.state, setupStep });
  }

  /** 通知唯一入口：同 key 替换，immediate 插队，其余进入队列。 */
  notify(notification: TuiNotification): void {
    const previous = this.state.notifications;
    const next = addNotification(previous, notification);
    if (next === previous) return;
    this.setState({ ...this.state, notifications: next });
    if (next.current !== previous.current) this.startNotificationTimer();
  }

  dismissNotification(key: string): void {
    const previous = this.state.notifications;
    const next = removeNotification(previous, key);
    if (next === previous) return;
    this.setState({ ...this.state, notifications: next });
    if (next.current !== previous.current) this.startNotificationTimer();
  }

  clearError(): void {
    if (this.state.localError === undefined) return;
    this.setState({ ...this.state, localError: undefined });
  }

  setPanel(panel: TuiPanel | undefined): void {
    if (this.state.panel === panel) return;
    this.setState({ ...this.state, panel });
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

  beginCompaction(): void {
    this.flush();
    this.setState({ ...this.state, compactionActive: true, localError: undefined });
  }

  finishCompaction(): void {
    this.flush();
    this.setState({ ...this.state, compactionActive: false });
  }

  beginRun(): void {
    this.flush();
    this.setState({ ...this.state, phase: "running", localError: undefined });
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
    this.clearNotificationTimer();
    this.pending = [];
    this.listeners.clear();
  }

  private startNotificationTimer(): void {
    this.clearNotificationTimer();
    const current = this.state.notifications.current;
    if (current === null) return;
    const timeoutMs = notificationTimeoutMs(current);
    if (timeoutMs === null) return;
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      this.advanceNotification();
    }, timeoutMs);
  }

  private advanceNotification(): void {
    const previous = this.state.notifications;
    const next = promoteNext({ current: null, queue: previous.queue });
    this.setState({ ...this.state, notifications: next });
    this.startNotificationTimer();
  }

  private clearNotificationTimer(): void {
    if (this.notificationTimer === undefined) return;
    clearTimeout(this.notificationTimer);
    this.notificationTimer = undefined;
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

function boundariesFromSnapshot(
  snapshot: ConversationSnapshot,
  current: readonly TuiCompactionBoundary[],
): readonly TuiCompactionBoundary[] {
  if (snapshot.contextCompactionBoundaries !== undefined) {
    return snapshot.contextCompactionBoundaries.map((boundary) => ({
      id: boundary.id,
      afterMessageId: boundary.throughMessageId,
      summary: boundary.summary,
      summarizedMessages: boundary.summarizedMessages,
      ...(boundary.instructions === undefined ? {} : { instructions: boundary.instructions }),
    }));
  }
  // 兼容尚未携带边界列表的旧 snapshot：只在成功状态出现时补一条。
  const next = snapshot.contextCompaction;
  if (next?.state !== "succeeded") return current;
  const id = `compaction:${next.finishedAt ?? next.updatedAt}`;
  if (current.some((boundary) => boundary.id === id)) return current;
  const afterMessageId = snapshot.messages.at(-1)?.id;
  return [...current, { id, ...(afterMessageId === undefined ? {} : { afterMessageId }) }];
}
