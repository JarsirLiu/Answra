import type { DesktopAnnouncement } from "@answra/shared";
import { CheckCheck, ChevronLeft, ChevronRight, Eraser } from "lucide-react";
import { useEffect, useState } from "react";
import { ICON, ICON_SM, ICON_STROKE } from "../../tokens";
import { SurfaceButton } from "../controls/SurfaceButton";
import { Tooltip } from "../controls/Tooltip";
import "./AnnouncementList.css";

const DISMISSED_STORAGE_KEY = "answra:dismissed-announcements";

function readDismissedIds() {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_STORAGE_KEY) ?? "null");
    if (Array.isArray(parsed)) {
      return new Set(
        parsed.filter(
          (value): value is number => typeof value === "number" && Number.isSafeInteger(value),
        ),
      );
    }
  } catch {
    // 损坏值与 theme.ts 的本地覆盖键同一处理：直接忽略。
  }
  return new Set<number>();
}

function writeDismissedIds(ids: Set<number>) {
  localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...ids]));
}

function formatDate(value: string) {
  return value ? new Date(value).toLocaleDateString() : "";
}

interface AnnouncementListProps {
  announcements: DesktopAnnouncement[];
  onMarkRead: (id: number) => Promise<void>;
}

function formatError(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

interface AnnouncementDetailProps {
  item: DesktopAnnouncement;
  error: string;
  onBack: () => void;
}

/** 详情态：全文在独立的滚动版式里展开，列表只承担导航。 */
function AnnouncementDetail({ item, error, onBack }: AnnouncementDetailProps) {
  return (
    <div className="announcement-detail">
      <button
        aria-label="返回公告列表"
        className="announcement-back"
        onClick={onBack}
        type="button"
      >
        <ChevronLeft aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
        全部公告
      </button>
      {error && (
        <p className="announcement-error" role="alert">
          {error}
        </p>
      )}
      <article className="announcement-detail__body">
        <h2>{item.title}</h2>
        <time>{formatDate(item.createdAt)}</time>
        <div className="announcement-detail__content">{item.content}</div>
      </article>
    </div>
  );
}

/**
 * 公告中心：列表只放标题/日期/未读点（导航版式），点开进详情读全文；
 * 未读条目打开详情时自动标记已读。工具栏提供全部已读与一次性清走已读
 * （已清走集合持久在 localStorage，见 2026-10-31 工具栏 Note）。
 */
export function AnnouncementList({ announcements, onMarkRead }: AnnouncementListProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState<Set<number>>(() => readDismissedIds());
  const [allBusy, setAllBusy] = useState(false);

  useEffect(() => {
    if (selectedId !== null && !announcements.some((item) => item.id === selectedId)) {
      // 登出/刷新把选中公告从数组里移走时退回列表，详情不能滞留陈旧内容。
      setSelectedId(null);
    }
  }, [announcements, selectedId]);

  // 派生量都以当前渲染为准；markAllRead 使用点击时渲染的快照遍历。
  const visible = announcements.filter((item) => !dismissed.has(item.id));
  const pendingUnread = visible.filter((item) => !item.readAt);
  const clearableCount = announcements.filter(
    (item) => item.readAt && !dismissed.has(item.id),
  ).length;

  async function markRead(id: number) {
    setError("");
    try {
      await onMarkRead(id);
    } catch (cause) {
      setError(formatError(cause, "标记已读失败"));
    }
  }

  async function markAllRead() {
    setError("");
    setAllBusy(true);
    try {
      for (const item of pendingUnread) {
        await onMarkRead(item.id);
      }
    } catch (cause) {
      setError(formatError(cause, "标记已读失败"));
    } finally {
      setAllBusy(false);
    }
  }

  function clearRead() {
    const next = new Set(dismissed);
    for (const item of announcements) {
      if (item.readAt) next.add(item.id);
    }
    setDismissed(next);
    writeDismissedIds(next);
  }

  function open(item: DesktopAnnouncement) {
    setSelectedId(item.id);
    setError("");
    if (!item.readAt) void markRead(item.id);
  }

  const selected =
    selectedId === null ? null : (announcements.find((item) => item.id === selectedId) ?? null);
  if (selected) {
    return (
      <AnnouncementDetail
        error={error}
        item={selected}
        onBack={() => {
          setSelectedId(null);
          setError("");
        }}
      />
    );
  }

  return (
    <div className="announcement-view">
      {error && (
        <p className="announcement-error" role="alert">
          {error}
        </p>
      )}
      <div className="announcement-toolbar">
        <Tooltip label="全部已读">
          <SurfaceButton
            aria-label="全部标为已读"
            className="announcement-toolbar-button"
            disabled={allBusy || pendingUnread.length === 0}
            onClick={() => void markAllRead()}
            variant="quiet"
          >
            <CheckCheck aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
          </SurfaceButton>
        </Tooltip>
        <Tooltip label="清除已读">
          <SurfaceButton
            aria-label="清除已读公告"
            className="announcement-toolbar-button"
            disabled={clearableCount === 0}
            onClick={clearRead}
            variant="quiet"
          >
            <Eraser aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
          </SurfaceButton>
        </Tooltip>
      </div>
      <div className="announcement-list">
        {visible.length === 0 ? (
          <p className="announcement-empty">暂无公告</p>
        ) : (
          visible.map((item) => (
            <button
              className={`announcement-row${item.readAt ? " is-read" : ""}`}
              key={item.id}
              onClick={() => open(item)}
              type="button"
            >
              {!item.readAt && <span aria-hidden="true" className="announcement-row__dot" />}
              <span className="announcement-row__title">{item.title}</span>
              <time className="announcement-row__time">{formatDate(item.createdAt)}</time>
              <ChevronRight
                aria-hidden="true"
                className="announcement-row__chevron"
                size={ICON_SM}
                strokeWidth={ICON_STROKE}
              />
            </button>
          ))
        )}
      </div>
    </div>
  );
}
