import type { ReplyBarActivity } from "@answra/shared";
import katex from "katex";
import {
  AlertCircle,
  Brain,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Wrench,
} from "lucide-react";
import { type ReactNode, useRef } from "react";
import { ICON } from "../../tokens";
import { useHorizontalTickerScroll } from "./useHorizontalTickerScroll";

interface ReplyActivityTickerProps {
  activities: ReplyBarActivity[];
  error?: string;
  pending?: boolean;
  onConversationHover?: () => void;
  replyText: string;
}

const EMPTY_ACTIVITY: ReplyBarActivity = {
  id: "waiting",
  kind: "status",
  label: "等待模型输出",
  text: "正在等待模型输出…",
};

export function ReplyActivityTicker({
  activities,
  error,
  pending,
  onConversationHover,
  replyText,
}: ReplyActivityTickerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const recentActivities = activities.length
    ? activities.slice(-5)
    : error
      ? [{ id: "error", kind: "error" as const, label: "模型错误", text: error }]
      : pending
        ? [EMPTY_ACTIVITY]
        : !replyText
          ? [
              {
                id: "empty",
                kind: "status" as const,
                label: "无回复",
                text: "模型未返回可展示内容",
              },
            ]
          : [];
  const latest = recentActivities.at(-1) ?? EMPTY_ACTIVITY;
  let lastProcessIndex = -1;
  for (let index = recentActivities.length - 1; index >= 0; index -= 1) {
    if (recentActivities[index]?.kind !== "text") {
      lastProcessIndex = index;
      break;
    }
  }
  const items =
    latest.kind === "text" ? recentActivities.slice(lastProcessIndex + 1) : recentActivities;
  const current = items.at(-1) ?? EMPTY_ACTIVITY;
  const currentLabel = current.label || getActivityLabel(current.kind);
  useHorizontalTickerScroll({
    viewportRef,
    trackRef,
    phase: current.kind === "text" ? "text" : "process",
    pending,
  });

  const Icon = getActivityIcon(current.kind);

  return (
    <div className={`reply-activity-ticker reply-activity-ticker--${current.kind}`}>
      <span
        aria-label={`当前事件：${currentLabel}`}
        className="reply-activity-indicator"
        role="img"
      >
        <Icon
          aria-hidden="true"
          className={pending && current.kind === "status" ? "reply-activity-spinner" : undefined}
          size={ICON}
        />
      </span>
      <div
        aria-label="模型回复活动"
        className="reply-activity-viewport"
        data-orientation="horizontal"
        onMouseEnter={onConversationHover}
        ref={viewportRef}
        role="log"
      >
        <div className="reply-activity-track" ref={trackRef}>
          {items.map((activity) => (
            <span
              className={`reply-activity-item reply-activity-item--${activity.kind}`}
              key={`${activity.id}-${activity.kind}`}
            >
              {activity.label ? <strong>{activity.label}</strong> : null}
              {activity.text ? <span>{renderInlineMath(activity.text)}</span> : null}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const INLINE_MATH = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

/**
 * 单行跑马灯里的公式渲染：只把 `$...$` / `$$...$$` 交给 KaTeX，其余保持纯文本，
 * 以保住 nowrap 的单行布局。统一按行内模式渲染（display 公式在跑马灯里不换行），
 * 未闭合的 `$` 在流式期间先显示原文，闭合后变为公式。
 */
function renderInlineMath(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  INLINE_MATH.lastIndex = 0;
  let match = INLINE_MATH.exec(text);
  while (match) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const source = match[1] ?? match[2] ?? "";
    nodes.push(
      <span
        className="reply-activity-math"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX 输出由纯文本生成，不含用户 HTML，等价于受控内容。
        dangerouslySetInnerHTML={{
          __html: katex.renderToString(source, { throwOnError: false, strict: false }),
        }}
        key={`math-${match.index}`}
      />,
    );
    lastIndex = match.index + match[0].length;
    match = INLINE_MATH.exec(text);
  }
  if (!nodes.length) return text;
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function getActivityIcon(kind: ReplyBarActivity["kind"]) {
  switch (kind) {
    case "thinking":
      return Brain;
    case "text":
      return MessageSquareText;
    case "tool":
      return Wrench;
    case "source":
      return FileText;
    case "error":
      return AlertCircle;
    default:
      return LoaderCircle;
  }
}

function getActivityLabel(kind: ReplyBarActivity["kind"]): string {
  switch (kind) {
    case "text":
      return "回答";
    case "thinking":
      return "思考";
    default:
      return "模型活动";
  }
}
