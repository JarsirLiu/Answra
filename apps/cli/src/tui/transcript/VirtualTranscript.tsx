/** 虚拟 transcript 视口：测量可见消息、只渲染窗口、保持底部跟随与 PgUp/PgDn。 */
import type { ConversationView, ConversationViewMessage } from "@answra/ui/conversation-view";
import { Box, type DOMElement, measureElement, useBoxMetrics, useInput, useWindowSize } from "ink";
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerSource } from "../interaction/pointerInput";
import { useDragAutoScroll } from "../interaction/useDragAutoScroll";
import type { TuiSetupStep } from "../modelSetup";
import { CompactionBoundaryRow } from "./CompactionBoundaryRow";
import type { TuiCompactionBoundary } from "./compactionBoundary";
import { MessageRow } from "./MessageRow";
import { SelectionContext } from "./SelectableText";
import { TranscriptTail, Welcome } from "./Transcript";
import {
  buildOffsets,
  estimateCompactionBoundaryHeight,
  estimateMessageHeight,
  findVirtualWindow,
  maxScrollTop,
  messageMeasureKey,
} from "./virtualLayout";

const OVERSCAN_LINES = 60;
const TAIL_ESTIMATE_LINES = 3;
const WHEEL_SCROLL_LINES = 3;
const EMPTY_HEIGHTS: ReadonlyMap<string, number> = new Map();

interface MeasuredHeights {
  readonly key: string;
  readonly values: ReadonlyMap<string, number>;
}

interface ScrollState {
  readonly top: number;
  readonly following: boolean;
}

type VirtualItem =
  | { readonly kind: "message"; readonly id: string; readonly message: ConversationViewMessage }
  | {
      readonly kind: "compaction-boundary";
      readonly id: string;
      readonly boundary: TuiCompactionBoundary;
    }
  | { readonly kind: "tail"; readonly id: "__tail__"; readonly node: ReactNode };

export function VirtualTranscript({
  view,
  compactionBoundaries = [],
  localError,
  workspaceRoot,
  modelConfigured,
  setupStep,
  transcriptMode,
  expandedToolIds,
  pointerSource,
}: {
  view: ConversationView;
  compactionBoundaries?: readonly TuiCompactionBoundary[];
  localError?: string;
  workspaceRoot: string;
  modelConfigured?: boolean;
  setupStep?: TuiSetupStep;
  transcriptMode: boolean;
  expandedToolIds?: ReadonlySet<string>;
  pointerSource?: PointerSource;
}) {
  const selectionStore = useContext(SelectionContext);
  const viewportRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const { columns } = useWindowSize();
  const expandedKey = expandedToolIds === undefined ? "" : [...expandedToolIds].sort().join(",");
  const layoutKey = `${columns}:${transcriptMode}:${expandedKey}`;
  const [measured, setMeasured] = useState<MeasuredHeights>(() => ({
    key: layoutKey,
    values: new Map(),
  }));
  const [scroll, setScroll] = useState<ScrollState>({ top: 0, following: true });
  const measuredValues = measured.key === layoutKey ? measured.values : EMPTY_HEIGHTS;

  const items = useMemo<VirtualItem[]>(() => {
    const messageItems = mergeCompactionBoundaries(view.messages, compactionBoundaries);
    return [
      ...messageItems,
      {
        kind: "tail",
        id: "__tail__",
        node: <TranscriptTail localError={localError} view={view} />,
      },
    ];
  }, [view, compactionBoundaries, localError]);

  const lastThinkingMessageId = useMemo(() => lastThinkingId(view.messages), [view.messages]);
  const heights = useMemo(
    () =>
      items.map(
        (item) =>
          measuredValues.get(item.id) ??
          (item.kind === "message"
            ? estimateMessageHeight(item.message, columns, transcriptMode, expandedToolIds)
            : item.kind === "compaction-boundary"
              ? estimateCompactionBoundaryHeight(item.boundary, columns, transcriptMode)
              : TAIL_ESTIMATE_LINES),
      ),
    [items, measuredValues, columns, transcriptMode, expandedToolIds],
  );
  const offsets = useMemo(() => buildOffsets(heights), [heights]);
  const totalHeight = offsets[offsets.length - 1] ?? 0;
  const viewportHeight = viewport.hasMeasured ? Math.max(1, viewport.clientHeight) : 1;
  const maxOffset = maxScrollTop(totalHeight, viewportHeight);
  const currentOffset = scroll.following ? maxOffset : Math.min(scroll.top, maxOffset);
  const virtualWindow = findVirtualWindow(offsets, currentOffset, viewportHeight, OVERSCAN_LINES);
  const viewportTop = viewport.hasMeasured ? viewport.top : 0;
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;
  const maxOffsetRef = useRef(maxOffset);
  maxOffsetRef.current = maxOffset;
  const pendingMeasures = useRef(new Map<string, number>());

  // 选区用内容行保存；这里只更新换算基准，滚动的焦点平移由 shiftViewport 负责。
  selectionStore?.setViewport({
    topRow: viewportTop,
    height: viewportHeight,
    offsetRows: currentOffset,
  });

  const applyMeasures = useCallback(
    (entries: Iterable<readonly [string, number]>) => {
      setMeasured((current) => {
        const next = new Map(current.key === layoutKey ? current.values : []);
        let changed = false;
        for (const [id, height] of entries) {
          if (next.get(id) === height) continue;
          next.set(id, height);
          changed = true;
        }
        if (!changed && current.key === layoutKey) return current;
        return { key: layoutKey, values: next };
      });
    },
    [layoutKey],
  );

  const flushPendingMeasures = useCallback(() => {
    const pending = pendingMeasures.current;
    if (pending.size === 0) return;
    pendingMeasures.current = new Map();
    applyMeasures(pending.entries());
  }, [applyMeasures]);

  const handleMeasure = useCallback(
    (id: string, height: number) => {
      if (height <= 0) return;
      // 选区存活期间冻结测量，否则新挂载项的高度会改写内容行坐标。
      if (selectionStore?.hasSelection() === true) {
        pendingMeasures.current.set(id, height);
        return;
      }
      applyMeasures([[id, height]]);
    },
    [applyMeasures, selectionStore],
  );

  const scrollBy = useCallback(
    (delta: number): number => {
      const current = scrollRef.current;
      const max = maxOffsetRef.current;
      const from = baseOffset(current, max);
      const to = Math.max(0, Math.min(max, from + delta));
      const actual = to - from;
      if (actual === 0) return 0;
      selectionStore?.shiftViewport(actual);
      const next = { top: to, following: to >= max };
      scrollRef.current = next;
      setScroll(next);
      return actual;
    },
    [selectionStore],
  );

  useInput((_input, key) => {
    if (key.pageUp) {
      scrollBy(-pageStep(viewportHeight));
      return;
    }
    if (key.pageDown) {
      scrollBy(pageStep(viewportHeight));
    }
  });

  useEffect(() => {
    if (pointerSource === undefined) return;
    return pointerSource.subscribe((event) => {
      if (event.kind !== "wheel") return;
      scrollBy(event.direction * WHEEL_SCROLL_LINES);
    });
  }, [pointerSource, scrollBy]);

  useDragAutoScroll({
    store: selectionStore,
    topRow: viewportTop,
    bottomRow: viewportTop + viewportHeight - 1,
    scrollBy,
  });

  const previousLayout = useRef({ messages: view.messages, boundaries: compactionBoundaries });
  useEffect(() => {
    const previous = previousLayout.current;
    if (previous.messages === view.messages && previous.boundaries === compactionBoundaries) {
      return;
    }
    previousLayout.current = { messages: view.messages, boundaries: compactionBoundaries };
    pendingMeasures.current = new Map();
    // 内容或压缩边界变化会移动内容行，旧选区与行缓存必须失效。
    selectionStore?.resetContent();
  }, [view.messages, compactionBoundaries, selectionStore]);

  const previousLayoutKey = useRef(layoutKey);
  useEffect(() => {
    if (previousLayoutKey.current === layoutKey) return;
    previousLayoutKey.current = layoutKey;
    pendingMeasures.current = new Map();
    selectionStore?.resetContent();
  }, [layoutKey, selectionStore]);

  useEffect(() => {
    if (selectionStore === undefined) return;
    let hadSelection = selectionStore.hasSelection();
    return selectionStore.subscribe(() => {
      const hasSelection = selectionStore.hasSelection();
      if (hadSelection && !hasSelection) flushPendingMeasures();
      hadSelection = hasSelection;
    });
  }, [flushPendingMeasures, selectionStore]);

  if (view.messages.length === 0) {
    return (
      <Box flexBasis={0} flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        <Welcome
          modelConfigured={modelConfigured}
          setupStep={setupStep}
          workspaceRoot={workspaceRoot}
        />
        <TranscriptTail localError={localError} view={view} />
      </Box>
    );
  }

  return (
    <Box
      flexBasis={0}
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflow="hidden"
      ref={viewportRef}
    >
      <Box
        contentOffsetY={virtualWindow.offsetWithin}
        flexDirection="column"
        flexShrink={0}
        width="100%"
      >
        {items.slice(virtualWindow.startIndex, virtualWindow.endIndex).map((item) => {
          const showReasoning =
            item.kind === "message" &&
            (transcriptMode || item.message.id === lastThinkingMessageId);
          return (
            <MeasuredItem
              id={item.id}
              key={item.id}
              measureKey={
                item.kind === "message"
                  ? `${columns}:${transcriptMode}:${expandedKey}:${showReasoning}:${messageMeasureKey(item.message)}`
                  : item.kind === "compaction-boundary"
                    ? `compaction-boundary:${columns}:${transcriptMode}:${item.boundary.summary?.length ?? 0}:${item.boundary.summarizedMessages ?? 0}:${item.boundary.instructions?.length ?? 0}`
                    : tailMeasureKey(view, localError, columns)
              }
              onMeasure={handleMeasure}
            >
              {item.kind === "message" ? (
                <MessageRow
                  expandedToolIds={expandedToolIds}
                  expandThinking={transcriptMode}
                  message={item.message}
                  showReasoning={showReasoning}
                />
              ) : item.kind === "compaction-boundary" ? (
                <CompactionBoundaryRow boundary={item.boundary} expanded={transcriptMode} />
              ) : (
                item.node
              )}
            </MeasuredItem>
          );
        })}
      </Box>
    </Box>
  );
}

function MeasuredItem({
  id,
  measureKey,
  onMeasure,
  children,
}: {
  id: string;
  measureKey: string;
  onMeasure: (id: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<DOMElement>(null);
  useLayoutEffect(() => {
    if (ref.current === null || measureKey.length === 0) return;
    onMeasure(id, measureElement(ref.current).height);
  }, [id, measureKey, onMeasure]);
  return (
    <Box flexDirection="column" flexShrink={0} ref={ref} width="100%">
      {children}
    </Box>
  );
}

function mergeCompactionBoundaries(
  messages: readonly ConversationViewMessage[],
  boundaries: readonly TuiCompactionBoundary[],
): VirtualItem[] {
  const leading: TuiCompactionBoundary[] = [];
  const after = new Map<string, TuiCompactionBoundary[]>();
  for (const boundary of boundaries) {
    if (boundary.afterMessageId === undefined) {
      leading.push(boundary);
      continue;
    }
    const anchored = after.get(boundary.afterMessageId);
    if (anchored === undefined) after.set(boundary.afterMessageId, [boundary]);
    else anchored.push(boundary);
  }

  const items: VirtualItem[] = leading.map(boundaryItem);
  for (const message of messages) {
    items.push({ kind: "message", id: message.id, message });
    const anchored = after.get(message.id);
    if (anchored === undefined) continue;
    after.delete(message.id);
    for (const boundary of anchored) items.push(boundaryItem(boundary));
  }
  for (const anchored of after.values()) {
    for (const boundary of anchored) items.push(boundaryItem(boundary));
  }
  return items;
}

function boundaryItem(boundary: TuiCompactionBoundary): VirtualItem {
  return { kind: "compaction-boundary", id: boundary.id, boundary };
}

function baseOffset(scroll: ScrollState, maxOffset: number): number {
  return scroll.following ? maxOffset : Math.min(scroll.top, maxOffset);
}

function pageStep(viewportHeight: number): number {
  return Math.max(1, viewportHeight - 1);
}

function tailMeasureKey(
  view: ConversationView,
  localError: string | undefined,
  columns: number,
): string {
  const retry =
    view.retry === undefined
      ? ""
      : `${view.retry.kind}:${view.retry.attempt}:${view.retry.maxRetries}:${view.retry.statusCode ?? ""}:${view.retry.finished}`;
  return `tail:${columns}:${view.error?.length ?? 0}:${localError?.length ?? 0}:${retry}`;
}

function lastThinkingId(messages: readonly ConversationViewMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === "user") return undefined;
    if (message.parts?.some((part) => part.kind === "reasoning") === true) return message.id;
  }
  return undefined;
}
