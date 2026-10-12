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
  const trackRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef<(kind?: ReplyBarActivity["kind"]) => void>(() => undefined);
  const scrollSpeedRef = useRef(140);
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
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track || typeof ResizeObserver === "undefined") return;

    let frame: number | undefined;
    let lastTime: number | undefined;
    const step = (time: number) => {
      if (lastTime === undefined) lastTime = time;
      const elapsed = Math.min(time - lastTime, 50);
      lastTime = time;
      const target = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const distance = target - viewport.scrollLeft;
      if (Math.abs(distance) <= 1) {
        viewport.scrollLeft = target;
        frame = undefined;
        lastTime = undefined;
        return;
      }
      viewport.scrollLeft +=
        Math.sign(distance) *
        Math.min(Math.abs(distance), (scrollSpeedRef.current * elapsed) / 1000);
      frame = requestAnimationFrame(step);
    };
    const followLatest = (kind?: ReplyBarActivity["kind"]) => {
      if (kind !== undefined) scrollSpeedRef.current = kind === "text" ? 24 : 140;
      if (frame === undefined) {
        lastTime = undefined;
        frame = requestAnimationFrame(step);
      }
    };

    followLatestRef.current = followLatest;
    const observer = new ResizeObserver(() => followLatest());
    observer.observe(viewport);
    observer.observe(track);
    followLatest();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      followLatestRef.current = () => undefined;
    };
  }, []);

  useLayoutEffect(() => {
    // Kind changes switch between quick process updates and slower answer reading.
    if (current.kind === "text" && viewportRef.current) viewportRef.current.scrollLeft = 0;
    followLatestRef.current(current.kind);
  }, [current.kind]);

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
