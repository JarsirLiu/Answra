/** TUI 投影 state：snapshot 初始化、事实帧折叠与 live 增量刷新；不碰终端 I/O。 */
import type { ConversationSnapshot, LiveFrame, SessionFrame } from "@answra/shared";
import {
  applyConversationSnapshot,
  type ConversationView,
  EMPTY_CONVERSATION_VIEW,
  foldConversationFrame,
  overlayLiveFrame,
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

const TUI_LIVE_BATCH_MS = 16;
/** live 增量积压上限：超过就先刷新，避免长时间不渲染。 */
const TUI_LIVE_QUEUE_MAX = 2_048;

/** 缺口重读口：durable 帧不连续时整段重读，不在本地推演缺失状态。 */
export interface TuiFrameReader {
  readFrames(conversationId: string, afterSeq: number): Promise<SessionFrame[]>;
}

export type TuiRunPhase = "idle" | "running" | "cancelling";

/** host 排队 turn 的展示投影；不是 transcript 消息，也不代表 run 已启动。 */
export interface TuiQueuedPrompt {
  readonly id: string;
  readonly text: string;
  readonly imageCount: number;
  readonly status: "queued" | "sending";
}

export interface TuiState {
  view: ConversationView;
  /** 压缩边界来自 conversation snapshot，只用于 TUI 展示。 */
  compactionBoundaries: readonly TuiCompactionBoundary[];
  /** 手动 `/compact` 正在等待首帧 snapshot；与 run phase 分开。 */
  compactionActive: boolean;
  phase: TuiRunPhase;
  /** 已交给 host、尚未开始 run 的 turn 数量；不包含正在提交的第一项。 */
  queued: number;
  queuedPrompts: readonly TuiQueuedPrompt[];
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

/** 单一 writer：snapshot、durable 帧与 live 增量都只经过这里更新 TUI state。 */
export class TuiViewStore {
  private state: TuiState = {
    view: EMPTY_CONVERSATION_VIEW,
    compactionBoundaries: [],
    compactionActive: false,
    phase: "idle",
    queued: 0,
    queuedPrompts: [],
    modelLabel: "",
    modelConfigured: false,
    authAvailable: false,
    authSignedIn: false,
    notifications: EMPTY_NOTIFICATION_STATE,
  };
  private readonly listeners = new Set<Listener>();
  private readonly reader?: TuiFrameReader;
  private pendingLive: LiveFrame[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private activeConversationId?: string;
  private syncing = false;
  private resync = false;

  constructor(reader?: TuiFrameReader) {
    this.reader = reader;
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): TuiState => this.state;

  initialize(snapshot: ConversationSnapshot): void {
    this.flushLive();
    this.activeConversationId = snapshot.conversationId;
    if (snapshot.lastSeq < this.state.view.lastSeq) return;
    this.pendingLive = [];
    this.setState({
      ...this.state,
      view: applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, snapshot),
      compactionBoundaries: boundariesFromSnapshot(snapshot, []),
      compactionActive: false,
      localError: undefined,
    });
    this.resync = true;
    void this.syncFrames();
  }

  /** 切到另一会话：先丢弃旧视图的游标与增量，再接收目标会话快照。 */
  switchConversation(snapshot: ConversationSnapshot): void {
    if (this.disposed) return;
    this.flushLive();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pendingLive = [];
    this.resync = false;
    this.activeConversationId = snapshot.conversationId;
    this.setState({
      ...this.state,
      view: applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, snapshot),
      compactionBoundaries: boundariesFromSnapshot(snapshot, []),
      compactionActive: false,
      phase: "idle",
      queued: 0,
      queuedPrompts: [],
      localError: undefined,
    });
    this.resync = true;
    void this.syncFrames();
  }

  applySnapshot(snapshot: ConversationSnapshot): void {
    if (this.disposed || snapshot.conversationId !== this.activeConversationId) return;
    this.flushLive();
    if (snapshot.lastSeq < this.state.view.lastSeq) return;
    // snapshot 已包含此前全部文本与事实，残留的 live 增量不得再叠加。
    this.pendingLive = [];
    this.setState({
      ...this.state,
      view: applyConversationSnapshot(this.state.view, snapshot),
      compactionBoundaries: boundariesFromSnapshot(snapshot, this.state.compactionBoundaries),
      localError: undefined,
    });
    this.resync = true;
    void this.syncFrames();
  }

  /** 折叠一条 durable 事实帧；缺口交给整段重读，不做本地补洞。 */
  applyFrame(frame: SessionFrame): void {
    if (this.disposed || frame.sessionId !== this.activeConversationId) return;
    this.foldFrame(frame);
    if (this.resync) void this.syncFrames();
  }

  /** 收集 live 增量，按帧批量刷新，避免每个 delta 触发一次渲染。 */
  applyLiveFrame(frame: LiveFrame): void {
    if (this.disposed || frame.sessionId !== this.activeConversationId) return;
    this.pendingLive.push(frame);
    if (this.pendingLive.length >= TUI_LIVE_QUEUE_MAX) {
      this.flushLive();
      return;
    }
    this.scheduleFlush();
  }

  /** `/clear` 后以空视图重建，避免旧 transcript 通过 snapshot 合并规则残留。 */
  reset(snapshot: ConversationSnapshot): void {
    if (this.disposed) return;
    this.flushLive();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pendingLive = [];
    this.resync = false;
    this.activeConversationId = snapshot.conversationId;
    this.clearNotificationTimer();
    this.setState({
      ...this.state,
      view: applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, snapshot),
      compactionBoundaries: [],
      compactionActive: false,
      queued: 0,
      queuedPrompts: [],
      localError: undefined,
      notifications: EMPTY_NOTIFICATION_STATE,
    });
    this.resync = true;
    void this.syncFrames();
  }

  setQueuedPrompts(queuedPrompts: readonly TuiQueuedPrompt[]): void {
    const queued = queuedPrompts.filter((prompt) => prompt.status === "queued").length;
    if (this.state.queued === queued && sameQueuedPrompts(this.state.queuedPrompts, queuedPrompts))
      return;
    this.setState({ ...this.state, queued, queuedPrompts });
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

  /** 应用已收集的 live 增量；snapshot 到达前它们是唯一的文本来源。 */
  flushLive(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pendingLive.length === 0) return;
    const pending = this.pendingLive;
    this.pendingLive = [];
    let view = this.state.view;
    for (const frame of pending) view = overlayLiveFrame(view, frame);
    if (view === this.state.view) return;
    this.setState({ ...this.state, view });
  }

  beginCompaction(): void {
    this.flushLive();
    this.setState({ ...this.state, compactionActive: true, localError: undefined });
  }

  finishCompaction(): void {
    this.flushLive();
    this.setState({ ...this.state, compactionActive: false });
  }

  beginRun(): void {
    this.flushLive();
    this.setState({ ...this.state, phase: "running", localError: undefined });
  }

  markCancelling(): void {
    this.setState({ ...this.state, phase: "cancelling" });
  }

  finishRun(): void {
    this.flushLive();
    this.setState({ ...this.state, phase: "idle" });
  }

  fail(message: string): void {
    this.flushLive();
    this.setState({ ...this.state, localError: message });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.clearNotificationTimer();
    this.pendingLive = [];
    this.resync = false;
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
      this.flushLive();
    }, TUI_LIVE_BATCH_MS);
  }

  private foldFrame(frame: SessionFrame): void {
    const view = this.state.view;
    if (frame.seq <= view.lastSeq) return;
    if (frame.seq !== view.lastSeq + 1) {
      this.resync = true;
      return;
    }
    const next = foldConversationFrame(view, frame);
    if (next === view) return;
    this.setState({ ...this.state, view: next });
  }

  /** durable 缺口只重读，不在本地推演：读取失败保留标记，下一次帧到达再试。 */
  private async syncFrames(): Promise<void> {
    if (this.syncing || !this.resync || this.disposed) return;
    const conversationId = this.activeConversationId;
    const reader = this.reader;
    if (conversationId === undefined || reader === undefined) return;
    this.syncing = true;
    try {
      while (this.resync && !this.disposed) {
        this.resync = false;
        const frames = await reader.readFrames(conversationId, this.state.view.lastSeq);
        if (this.activeConversationId !== conversationId) return;
        for (const frame of frames) this.foldFrame(frame);
      }
    } catch (error) {
      this.resync = true;
      console.error("[tui] failed to read session frames", error);
    } finally {
      this.syncing = false;
    }
  }

  private setState(next: TuiState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

function sameQueuedPrompts(a: readonly TuiQueuedPrompt[], b: readonly TuiQueuedPrompt[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (prompt, index) =>
        prompt.id === b[index]?.id &&
        prompt.text === b[index]?.text &&
        prompt.imageCount === b[index]?.imageCount &&
        prompt.status === b[index]?.status,
    )
  );
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
