import type { ReplyBarActivity } from "@answra/shared";
import {
  AlertCircle,
  Brain,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Wrench,
} from "lucide-react";
import { useRef } from "react";
import { useHorizontalTickerScroll } from "./useHorizontalTickerScroll";

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
        title={currentLabel}
      >
        <Icon
          aria-hidden="true"
          className={pending && current.kind === "status" ? "reply-activity-spinner" : undefined}
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
        <div className="reply-activity-track" ref={trackRef}>
          {items.map((activity) => (
            <span
              className={`reply-activity-item reply-activity-item--${activity.kind}`}
              key={`${activity.id}-${activity.kind}`}
            >
              {activity.label ? <strong>{activity.label}</strong> : null}
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
