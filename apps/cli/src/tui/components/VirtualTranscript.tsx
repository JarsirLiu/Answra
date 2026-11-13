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
import type { WheelSource } from "../wheelInput";
import { MessageRow } from "./MessageRow";
import { TranscriptTail, Welcome } from "./Transcript";
import {
  buildOffsets,
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
  | { readonly kind: "footer"; readonly id: "__footer__"; readonly node: ReactNode };

export function VirtualTranscript({
  view,
  localError,
  notice,
  workspaceRoot,
  expandThinking,
  footer,
  wheelSource,
}: {
  view: ConversationView;
  localError?: string;
  notice?: readonly string[];
  workspaceRoot: string;
  expandThinking: boolean;
  footer?: ReactNode;
  wheelSource?: WheelSource;
}) {
  const viewportRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const { columns } = useWindowSize();
  const layoutKey = `${columns}:${expandThinking}`;
  const [measured, setMeasured] = useState<MeasuredHeights>(() => ({
    key: layoutKey,
    values: new Map(),
  }));
  const [scroll, setScroll] = useState<ScrollState>({ top: 0, following: true });
  const measuredValues = measured.key === layoutKey ? measured.values : EMPTY_HEIGHTS;

  const items = useMemo<VirtualItem[]>(() => {
    const messageItems = view.messages.map(
      (message): VirtualItem => ({ kind: "message", id: message.id, message }),
    );
    return footer === undefined
      ? messageItems
      : [...messageItems, { kind: "footer", id: "__footer__", node: footer }];
  }, [view.messages, footer]);

  const lastThinkingMessageId = useMemo(() => lastThinkingId(view.messages), [view.messages]);
  const heights = useMemo(
    () =>
      items.map(
        (item) =>
          measuredValues.get(item.id) ??
          (item.kind === "message"
            ? estimateMessageHeight(item.message, columns, expandThinking)
            : FOOTER_ESTIMATE_LINES),
      ),
    [items, measuredValues, columns, expandThinking],
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
      setScroll((current) => {
        const top = Math.max(0, baseOffset(current, maxOffset) - pageStep(viewportHeight));
        if (!current.following && current.top === top) return current;
        return { top, following: false };
      });
      return;
    }
    if (key.pageDown) {
      setScroll((current) => {
        const top = Math.min(maxOffset, baseOffset(current, maxOffset) + pageStep(viewportHeight));
        const following = top >= maxOffset;
        if (current.following === following && current.top === top) return current;
        return { top, following };
      });
    }
  });

  useEffect(() => {
    if (wheelSource === undefined) return;
    return wheelSource.subscribe((direction) => {
      setScroll((current) => {
        const top = Math.max(
          0,
          Math.min(maxOffset, baseOffset(current, maxOffset) + direction * WHEEL_SCROLL_LINES),
        );
        const following = top >= maxOffset;
        if (current.following === following && current.top === top) return current;
        return { top, following };
      });
    });
  }, [maxOffset, wheelSource]);

  if (view.messages.length === 0) {
    return (
      <Box flexBasis={0} flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        <Welcome workspaceRoot={workspaceRoot} />
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
                  ? `${columns}:${expandThinking}:${showReasoning}:${messageMeasureKey(item.message)}`
                  : `footer:${columns}`
              }
              onMeasure={handleMeasure}
            >
              {item.kind === "message" ? (
                <MessageRow
                  expandThinking={expandThinking}
                  message={item.message}
                  showReasoning={showReasoning}
                />
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
