import { ImagePlus, Send, X } from "lucide-react";
import type { FormEvent, RefObject } from "react";
import { ICON_SM } from "../../tokens";
import type { ChatAttachment } from "./ChatPanel";
import "./ReplyBar.css";

/** 回复条两种形态：编辑预备区（composing）/ 流式滚动回复（streaming）。 */
export type ReplyPhase = "composing" | "streaming";

interface ReplyBarProps {
  /** 当前形态。 */
  phase: ReplyPhase;
  /** 本轮预备发送的多张截图。 */
  attachments: ChatAttachment[];
  draft: string;
  /** 流式展示中的 AI 回复文本（streaming 态）。 */
  replyText: string;
  /** 隐藏的文件选择框 ref（无捕获桥时回落选择本地图片）。 */
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  /** 从文件选择框追加一张本地图片。 */
  onAttachmentChange: (file: File | null) => void;
  /** 移除某张预备截图（按 id）。 */
  onAttachmentRemove: (id: string) => void;
  /** 在原地回复条内继续追加一次截图。 */
  onScreenshot: () => void;
  /** 确认发送：进入流式态。 */
  onSend: () => void;
  /** 收起回复条（放弃本轮，或结束流式展示）。 */
  onClose: () => void;
}

/**
 * 横条式回复条：编辑态以占位块表示已添加截图，点发送后整条变成匀速滚动的跑马灯
 * 输出 AI 回复，左侧波形动效传达“正在说话”的活体感；不打开、不复用对话面板。
 */
export function ReplyBar({
  phase,
  attachments,
  draft,
  replyText,
  fileInputRef,
  onDraftChange,
  onAttachmentChange,
  onAttachmentRemove,
  onScreenshot,
  onSend,
  onClose,
}: ReplyBarProps) {
  if (phase === "streaming") {
    // 匀速：动画时长随文本长度线性增长，保证恒定像素速度（恒定阅读节奏）。
    const duration = Math.max(8, replyText.length * 0.3);
    return (
      <section aria-live="polite" className="reply-bar reply-bar--stream input-surface">
        <div className="waveform" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="ticker">
          <span className="ticker-text" style={{ animationDuration: `${duration}s` }}>
            {replyText}
          </span>
        </div>
        <button aria-label="收起回复条" className="reply-close" onClick={onClose} type="button">
          <X aria-hidden="true" size={ICON_SM} />
        </button>
      </section>
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSend();
  }

  return (
    <section className="reply-bar reply-bar--compose input-surface">
      <form className="reply-compose" onSubmit={handleSubmit}>
        <input
          accept="image/*"
          aria-label="选择截图图片"
          className="file-input-hidden"
          onChange={(event) => {
            onAttachmentChange(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
          ref={fileInputRef}
          type="file"
        />
        {attachments.length > 0 && (
          <div className="attachment-strip">
            {attachments.map((att) => (
              <div className="attachment-thumb" key={att.id}>
                {/* 排查系统截图黑块时不在原生窗口中解码或绘制截图缩略图。 */}
                <span aria-label="截图已添加" className="attachment-placeholder" role="img">
                  已添加
                </span>
                <button
                  aria-label="移除截图"
                  onClick={() => onAttachmentRemove(att.id)}
                  type="button"
                >
                  <X aria-hidden="true" size={ICON_SM} />
                </button>
              </div>
            ))}
            <button
              aria-label="继续添加截图"
              className="attachment-add"
              onClick={onScreenshot}
              title="继续截图"
              type="button"
            >
              <ImagePlus aria-hidden="true" size={ICON_SM} />
            </button>
          </div>
        )}
        <input
          aria-label="补充问题"
          className="reply-input"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={attachments.length ? "补充问题或说明…" : "输入问题，或先从模式功能添加截图…"}
          value={draft}
        />
      </form>
      <div className="reply-actions">
        <button aria-label="继续截图" className="reply-ghost" onClick={onScreenshot} type="button">
          <ImagePlus aria-hidden="true" size={ICON_SM} />
          继续截图
        </button>
        <button
          aria-label="确认发送"
          className="reply-send"
          disabled={!draft.trim() && attachments.length === 0}
          onClick={onSend}
          type="button"
        >
          <Send aria-hidden="true" size={ICON_SM} />
          确认发送
        </button>
        <button aria-label="收起回复条" className="reply-close" onClick={onClose} type="button">
          <X aria-hidden="true" size={ICON_SM} />
        </button>
      </div>
    </section>
  );
}
