import type { DesktopAnnouncement } from "@answra/shared";
import { Check } from "lucide-react";
import { useState } from "react";
import { SurfaceButton } from "../controls/SurfaceButton";
import "./AnnouncementList.css";

interface AnnouncementListProps {
  announcements: DesktopAnnouncement[];
  onMarkRead: (id: number) => Promise<void>;
}

/** 公告列表：设置面板「公告」入口的内容；错误/ busy 状态由列表自持，外壳不重复处理。 */
export function AnnouncementList({ announcements, onMarkRead }: AnnouncementListProps) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function markRead(id: number) {
    setBusyId(id);
    setError("");
    try {
      await onMarkRead(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "标记已读失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="announcement-list">
      {error && (
        <p className="announcement-error" role="alert">
          {error}
        </p>
      )}
      {announcements.length === 0 ? (
        <p className="announcement-empty">暂无公告</p>
      ) : (
        announcements.map((item) => (
          <article className={`announcement-item${item.readAt ? " is-read" : ""}`} key={item.id}>
            <div className="announcement-item__heading">
              <h2>{item.title}</h2>
              {!item.readAt && <span className="announcement-unread">未读</span>}
              {item.notifyMode === "popup" && <span className="announcement-priority">重要</span>}
            </div>
            <p className="announcement-item__content">{item.content}</p>
            <footer>
              <time>{item.createdAt ? new Date(item.createdAt).toLocaleDateString() : ""}</time>
              {!item.readAt && (
                <SurfaceButton
                  aria-label={`标记已读：${item.title}`}
                  className="announcement-read-button"
                  disabled={busyId === item.id}
                  onClick={() => void markRead(item.id)}
                  title="标记已读"
                  variant="quiet"
                >
                  <Check aria-hidden="true" size={14} />
                  已读
                </SurfaceButton>
              )}
            </footer>
          </article>
        ))
      )}
    </div>
  );
}
