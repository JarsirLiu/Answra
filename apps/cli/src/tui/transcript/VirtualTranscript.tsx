/** 虚拟 transcript 视口：测量可见消息、只渲染窗口、保持底部跟随与 PgUp/PgDn。 */
import type { ConversationView, ConversationViewMessage } from "@answra/ui/conversation-view";
import { Box, type DOMElement, measureElement, useBoxMetrics, useInput, useWindowSize } from "ink";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerSource } from "../interaction/pointerInput";
import type { TuiSetupStep } from "../modelSetup";
import { CompactionBoundaryRow } from "./CompactionBoundaryRow";
import type { TuiCompactionBoundary } from "./compactionBoundary";
import { MessageRow } from "./MessageRow";
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
const FOOTER_ESTIMATE_LINES = 3;
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
  | { readonly kind: "footer"; readonly id: "__footer__"; readonly node: ReactNode };

export function VirtualTranscript({
  view,
  compactionBoundaries = [],
  localError,
  notice,
  workspaceRoot,
  modelConfigured,
  setupStep,
  expandThinking,
  expandedToolIds,
  footer,
  pointerSource,
  onScroll,
}: {
  view: ConversationView;
  compactionBoundaries?: readonly TuiCompactionBoundary[];
  localError?: string;
  notice?: readonly string[];
  workspaceRoot: string;
  modelConfigured?: boolean;
  setupStep?: TuiSetupStep;
  expandThinking: boolean;
  expandedToolIds?: ReadonlySet<string>;
  footer?: ReactNode;
  pointerSource?: PointerSource;
  onScroll?: () => void;
}) {
  const viewportRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const { columns } = useWindowSize();
  const expandedKey = expandedToolIds === undefined ? "" : [...expandedToolIds].sort().join(",");
  const layoutKey = `${columns}:${expandThinking}:${expandedKey}`;
  const [measured, setMeasured] = useState<MeasuredHeights>(() => ({
    key: layoutKey,
    values: new Map(),
  }));
  const [scroll, setScroll] = useState<ScrollState>({ top: 0, following: true });
  const measuredValues = measured.key === layoutKey ? measured.values : EMPTY_HEIGHTS;

  const items = useMemo<VirtualItem[]>(() => {
    const messageItems = mergeCompactionBoundaries(view.messages, compactionBoundaries);
    const tail = <TranscriptTail localError={localError} notice={notice} view={view} />;
    const tailNode =
      footer === undefined ? (
        tail
      ) : (
        <>
          {tail}
          {footer}
        </>
      );
    return [...messageItems, { kind: "footer", id: "__footer__", node: tailNode }];
  }, [view, compactionBoundaries, footer, localError, notice]);

  const lastThinkingMessageId = useMemo(() => lastThinkingId(view.messages), [view.messages]);
  const heights = useMemo(
    () =>
      items.map(
        (item) =>
          measuredValues.get(item.id) ??
          (item.kind === "message"
            ? estimateMessageHeight(item.message, columns, expandThinking, expandedToolIds)
            : item.kind === "compaction-boundary"
              ? estimateCompactionBoundaryHeight(item.boundary, columns, expandThinking)
              : FOOTER_ESTIMATE_LINES),
      ),
    [items, measuredValues, columns, expandThinking, expandedToolIds],
  );
  const offsets = useMemo(() => buildOffsets(heights), [heights]);
  const totalHeight = offsets[offsets.length - 1] ?? 0;
  const viewportHeight = viewport.hasMeasured ? Math.max(1, viewport.clientHeight) : 1;
  const maxOffset = maxScrollTop(totalHeight, viewportHeight);
  const currentOffset = scroll.following ? maxOffset : Math.min(scroll.top, maxOffset);
  const virtualWindow = findVirtualWindow(offsets, currentOffset, viewportHeight, OVERSCAN_LINES);

  const handleMeasure = useCallback(
    (id: string, height: number) => {
      if (height <= 0) return;
      setMeasured((current) => {
        if (current.key === layoutKey && current.values.get(id) === height) return current;
        const next = new Map(current.key === layoutKey ? current.values : []);
        next.set(id, height);
        return { key: layoutKey, values: next };
      });
    },
    [layoutKey],
  );

  useInput((_input, key) => {
    if (key.pageUp) {
      onScroll?.();
      setScroll((current) => {
        const top = Math.max(0, baseOffset(current, maxOffset) - pageStep(viewportHeight));
        if (!current.following && current.top === top) return current;
        return { top, following: false };
      });
      return;
    }
    if (key.pageDown) {
      onScroll?.();
      setScroll((current) => {
        const top = Math.min(maxOffset, baseOffset(current, maxOffset) + pageStep(viewportHeight));
        const following = top >= maxOffset;
        if (current.following === following && current.top === top) return current;
        return { top, following };
      });
    }
  });

  useEffect(() => {
    if (pointerSource === undefined) return;
    return pointerSource.subscribe((event) => {
      if (event.kind !== "wheel") return;
      onScroll?.();
      setScroll((current) => {
        const top = Math.max(
          0,
          Math.min(
            maxOffset,
            baseOffset(current, maxOffset) + event.direction * WHEEL_SCROLL_LINES,
          ),
        );
        const following = top >= maxOffset;
        if (current.following === following && current.top === top) return current;
        return { top, following };
      });
    });
  }, [maxOffset, onScroll, pointerSource]);

  const previousLayout = useRef({ messages: view.messages, boundaries: compactionBoundaries });
  useEffect(() => {
    const previous = previousLayout.current;
    if (previous.messages === view.messages && previous.boundaries === compactionBoundaries) {
      return;
    }
    previousLayout.current = { messages: view.messages, boundaries: compactionBoundaries };
    // 内容或压缩边界变化会移动已登记行的屏幕坐标，旧选区必须失效。
    onScroll?.();
  }, [view.messages, compactionBoundaries, onScroll]);

  if (view.messages.length === 0) {
    return (
      <Box flexBasis={0} flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        <Welcome
          modelConfigured={modelConfigured}
          setupStep={setupStep}
          workspaceRoot={workspaceRoot}
        />
        <TranscriptTail localError={localError} notice={notice} view={view} />
        {footer}
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
            (expandThinking || item.message.id === lastThinkingMessageId);
          return (
            <MeasuredItem
              id={item.id}
              key={item.id}
              measureKey={
                item.kind === "message"
                  ? `${columns}:${expandThinking}:${expandedKey}:${showReasoning}:${messageMeasureKey(item.message)}`
                  : item.kind === "compaction-boundary"
                    ? `compaction-boundary:${columns}:${expandThinking}:${item.boundary.summary?.length ?? 0}:${item.boundary.instructions?.length ?? 0}`
                    : `footer:${columns}`
              }
              onMeasure={handleMeasure}
            >
              {item.kind === "message" ? (
                <MessageRow
                  expandedToolIds={expandedToolIds}
                  expandThinking={expandThinking}
                  message={item.message}
                  showReasoning={showReasoning}
                />
              ) : item.kind === "compaction-boundary" ? (
                <CompactionBoundaryRow boundary={item.boundary} expanded={expandThinking} />
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

function lastThinkingId(messages: readonly ConversationViewMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === "user") return undefined;
    if (message.parts?.some((part) => part.kind === "reasoning") === true) return message.id;
  }
  return undefined;
}
