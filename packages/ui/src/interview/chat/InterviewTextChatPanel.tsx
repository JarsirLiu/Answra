/** 面试演练/辅助共用的文本对话页；消息流与输入框复用 ChatPanel，不复制投影。 */

import type { DesktopBridge } from "@answra/shared";
import { ActiveInterviewConversationId } from "@answra/shared";
import { Bot, Mic, MicOff, User } from "lucide-react";
import { useRef } from "react";
import { IconButton } from "../../components/controls/IconButton";
import { SurfaceButton } from "../../components/controls/SurfaceButton";
import { ChatPanel } from "../../components/panels/ChatPanel";
import { ICON } from "../../tokens";
import { useTtsPlayback } from "../../tts/useTtsPlayback";
import { useInterviewMicrophone } from "../voice/useInterviewMicrophone";
import { type InterviewTextChatMode, useInterviewTextChat } from "./useInterviewTextChat";
import "./chat.css";

export type { InterviewTextChatMode } from "./useInterviewTextChat";

interface InterviewTextChatPanelProps {
  platform: DesktopBridge | undefined;
  mode: InterviewTextChatMode;
  onClose: () => void;
  onModeChange: (mode: InterviewTextChatMode) => void;
  /** 本地模型可用时传入：登录失败提示里给出「配置本地模型」替代路径。 */
  onConfigureModel?: () => void;
}

const COPY = {
  rehearsal: {
    placeholder: "回答演练官的问题，或输入想练的面试题型…",
    title: "面试演练",
  },
  assist: {
    placeholder: "粘贴面试官的问题，获取基于本人经历的回答建议…",
    title: "面试辅助",
  },
} as const;

export function InterviewTextChatPanel({
  platform,
  mode,
  onClose,
  onModeChange,
  onConfigureModel,
}: InterviewTextChatPanelProps) {
  const chat = useInterviewTextChat(platform, mode);
  const tts = useTtsPlayback(platform);
  const microphone = useInterviewMicrophone(platform, ActiveInterviewConversationId);
  const copy = COPY[mode];
  const fileInputRef = useRef<HTMLInputElement>(null);

  function toggleMicrophone(): void {
    // 开麦即打断面试官朗读；辅助模式没有麦克风按钮，不会插话。
    if (!microphone.active) platform?.stopTts?.({ conversationId: ActiveInterviewConversationId });
    microphone.toggle();
  }

  const headerAction = (
    <div className="interview-mode-actions">
      {mode === "rehearsal" ? (
        <>
          <IconButton
            aria-pressed={microphone.active}
            disabled={microphone.starting}
            icon={microphone.active ? MicOff : Mic}
            label={microphone.active ? "停止语音输入" : "开始语音输入"}
            onClick={toggleMicrophone}
            size="sm"
            variant="quiet"
          />
          {microphone.active ? (
            <span aria-hidden="true" className="interview-mic-level">
              <span style={{ width: `${Math.round(microphone.level * 100)}%` }} />
            </span>
          ) : null}
        </>
      ) : null}
      <fieldset aria-label="面试模式" className="interview-mode-switch">
        <SurfaceButton
          aria-label="面试官模式：面试演练"
          aria-pressed={mode === "rehearsal"}
          className="interview-mode-option"
          onClick={() => onModeChange("rehearsal")}
          size="sm"
        >
          <Bot size={ICON} />
          演练
        </SurfaceButton>
        <SurfaceButton
          aria-label="候选者模式：面试辅助"
          aria-pressed={mode === "assist"}
          className="interview-mode-option"
          onClick={() => onModeChange("assist")}
          size="sm"
        >
          <User size={ICON} />
          辅助
        </SurfaceButton>
      </fieldset>
    </div>
  );

  const notice =
    microphone.error || tts.failure ? (
      <div className="interview-tts-notice" role="status">
        <span>{microphone.error ?? tts.failure}</span>
        {tts.failure ? (
          <SurfaceButton onClick={tts.dismissFailure} size="sm" variant="quiet">
            知道了
          </SurfaceButton>
        ) : null}
      </div>
    ) : undefined;

  return (
    <ChatPanel
      attachments={[]}
      bridge={platform}
      draft={chat.draft}
      error={chat.error}
      fileInputRef={fileInputRef}
      headerAction={headerAction}
      inputLabel="输入消息"
      messages={chat.messages}
      notice={notice}
      onAloud={
        platform?.speakTts
          ? (messageId, text) => {
              void platform.speakTts?.({ messageId, text });
            }
          : undefined
      }
      onAttachmentChange={() => undefined}
      onAttachmentRemove={() => undefined}
      onCancel={chat.cancel}
      onClose={onClose}
      onSignIn={chat.needsSignIn ? () => void chat.signIn() : undefined}
      onConfigureModel={chat.needsSignIn ? onConfigureModel : undefined}
      onDraftChange={chat.setDraft}
      onSend={() => {
        void chat.send().catch(() => undefined);
      }}
      placeholder={copy.placeholder}
      sending={chat.opening || (chat.sendPending && !chat.activeMessageId)}
      showAttachments={false}
      stealth={false}
      streaming={Boolean(chat.activeMessageId)}
      title={copy.title}
      variant="interview"
    />
  );
}
