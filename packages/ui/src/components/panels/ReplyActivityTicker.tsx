import type { ReplyBarActivity } from "@answra/shared";
import {
  AlertCircle,
  Brain,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Wrench,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";

interface ReplyActivityTickerProps {
  activities: ReplyBarActivity[];
  error?: string;
  pending?: boolean;
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
  replyText,
}: ReplyActivityTickerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const items = activities.length
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
  const current = items.at(-1) ?? EMPTY_ACTIVITY;
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollLeft = viewport.scrollWidth;
  });

  const Icon = getActivityIcon(current.kind);

  return (
    <div className={`reply-activity-ticker reply-activity-ticker--${current.kind}`}>
      <span
        aria-label={`当前事件：${current.label}`}
        className="reply-activity-indicator"
        role="img"
        title={current.label}
      >
        <Icon
          aria-hidden="true"
          className={pending ? "reply-activity-spinner" : undefined}
          size={16}
        />
      </span>
      <div
        aria-label="模型回复活动"
        className="reply-activity-viewport"
        data-orientation="horizontal"
        ref={viewportRef}
        role="log"
      >
        <div className="reply-activity-track">
          {items.map((activity) => (
            <span
              className={`reply-activity-item reply-activity-item--${activity.kind}`}
              key={`${activity.id}-${activity.kind}`}
            >
              <strong>{activity.label}</strong>
              {activity.text ? <span>{activity.text}</span> : null}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
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
