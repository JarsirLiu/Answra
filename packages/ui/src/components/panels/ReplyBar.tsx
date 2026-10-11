import { Camera, Send, Square, X } from "lucide-react";
import type { RefObject } from "react";
import { ICON, ICON_SM, ICON_STROKE } from "../../tokens";
import { SurfaceButton } from "../controls/SurfaceButton";
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
  /** 取消当前回复，回到同一条回复条的发送态。 */
  onCancel: () => void;
}

/**
 * 横条式回复条：编辑态 = 截图缩略条 + 图标操作组（条内不设输入框，隐身模式
 * 下打字经输入法候选窗会被捕获暴露）；点发送后左侧整体变成匀速滚动的跑马灯
 * 输出 AI 回复，发送键原位切换为可点击取消的“进行中”停止键，取消后回到
 * 发送态；不打开、不复用对话面板。
 */
export function ReplyBar({
  phase,
  attachments,
  draft,
  replyText,
  fileInputRef,
  onAttachmentChange,
  onAttachmentRemove,
  onScreenshot,
  onSend,
  onClose,
  onCancel,
}: ReplyBarProps) {
  if (phase === "streaming") {
    // 匀速：动画时长随文本长度线性增长，保证恒定像素速度（恒定阅读节奏）。
    const duration = Math.max(8, replyText.length * 0.3);
    return (
      <section aria-live="polite" className="reply-bar reply-bar--stream floating-surface">
        <div className="ticker">
          <span className="ticker-text" style={{ animationDuration: `${duration}s` }}>
            {replyText}
          </span>
        </div>
        {/* 原发送键的位置切换为“进行中”停止键，点击取消并回退到发送态。 */}
        <SurfaceButton
          aria-label="取消回复并返回发送"
          className="reply-stop"
          onClick={onCancel}
          type="button"
          variant="primary"
        >
          <Square aria-hidden="true" fill="currentColor" size={ICON_SM} strokeWidth={ICON_STROKE} />
        </SurfaceButton>
        <SurfaceButton aria-label="收起回复条" className="reply-close" onClick={onClose}>
          <X aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
        </SurfaceButton>
      </section>
    );
  }

  return (
    <section className="reply-bar reply-bar--compose floating-surface">
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
        <fieldset className="attachment-strip" aria-label="待发送截图">
          {attachments.map((att) => (
            <div className="attachment-thumb" key={att.id}>
              {/* 回复条是受保护的独立窗口，缩略图只在本地窗口绘制，不进入系统采集。 */}
              <img
                alt={att.name || "截图缩略图"}
                className="attachment-thumb-image"
                src={att.previewUrl}
              />
              <SurfaceButton
                aria-label="移除截图"
                className="attachment-remove"
                onClick={() => onAttachmentRemove(att.id)}
              >
                <X aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
              </SurfaceButton>
            </div>
          ))}
        </fieldset>
      )}
      <div className="reply-actions">
        <SurfaceButton aria-label="继续截图" onClick={onScreenshot}>
          <Camera aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
        </SurfaceButton>
        <SurfaceButton
          aria-label="确认发送"
          className="reply-send"
          disabled={!draft.trim() && attachments.length === 0}
          onClick={onSend}
          variant="primary"
        >
          <Send aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
        </SurfaceButton>
        <SurfaceButton aria-label="收起回复条" className="reply-close" onClick={onClose}>
          <X aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
        </SurfaceButton>
      </div>
    </section>
  );
}
