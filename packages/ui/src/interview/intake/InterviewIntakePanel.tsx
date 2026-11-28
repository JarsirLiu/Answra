/** 制作分身对话页：普通消息流与输入框，资料足够时由用户点击进入演练。 */

import type { DesktopBridge } from "@answra/shared";
import { ActiveInterviewIntakeConversationId } from "@answra/shared";
import { Mic, MicOff } from "lucide-react";
import { useRef, useState } from "react";
import { IconButton } from "../../components/controls/IconButton";
import { SurfaceButton } from "../../components/controls/SurfaceButton";
import { ChatPanel } from "../../components/panels/ChatPanel";
import { useInterviewMicrophone } from "../voice/useInterviewMicrophone";
import { useInterviewIntake } from "./useInterviewIntake";

interface InterviewIntakePanelProps {
  platform: DesktopBridge | undefined;
  onClose: () => void;
  /** 用户显式进入演练；切换不由模型解析自然语言决定。 */
  onStartRehearsal: () => Promise<void>;
  onReopenOnboarding: () => Promise<void>;
  /** 引导状态读写失败；与对话自身的错误互斥展示。 */
  error?: string;
}

export function InterviewIntakePanel({
  platform,
  onClose,
  onStartRehearsal,
  onReopenOnboarding,
  error,
}: InterviewIntakePanelProps) {
  const intake = useInterviewIntake(platform);
  const microphone = useInterviewMicrophone(platform, ActiveInterviewIntakeConversationId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [starting, setStarting] = useState(false);

  async function startRehearsal(): Promise<void> {
    if (starting) return;
    setStarting(true);
    try {
      // 切阶段前先停采集，避免残留帧继续落进 intake 会话。
      await microphone.stop();
      await onStartRehearsal();
    } catch {
      // 错误由引导状态入口写入，面板只负责按钮可用性。
    } finally {
      setStarting(false);
    }
  }

  const headerAction = (
    <>
      <IconButton
        aria-pressed={microphone.active}
        disabled={microphone.starting || starting}
        icon={microphone.active ? MicOff : Mic}
        label={microphone.active ? "停止语音输入" : "开始语音输入"}
        onClick={microphone.toggle}
        size="sm"
        variant="quiet"
      />
      {intake.error && intake.messages.length === 0 ? (
        <SurfaceButton onClick={intake.retryOpen} variant="quiet">
          重试
        </SurfaceButton>
      ) : null}
      <SurfaceButton
        onClick={() => {
          void onReopenOnboarding().catch(() => undefined);
        }}
        variant="quiet"
      >
        资料
      </SurfaceButton>
      <SurfaceButton
        disabled={intake.opening || starting}
        onClick={() => void startRehearsal()}
        variant="primary"
      >
        开始面试演练
      </SurfaceButton>
    </>
  );

  return (
    <ChatPanel
      attachments={intake.attachments}
      bridge={platform}
      draft={intake.draft}
      error={microphone.error ?? intake.error ?? error}
      fileInputRef={fileInputRef}
      headerAction={headerAction}
      inputLabel="输入消息"
      messages={intake.messages}
      onAttachmentChange={(file) => {
        if (file) intake.addAttachment(file);
      }}
      onAttachmentRemove={intake.removeAttachment}
      onCancel={intake.cancel}
      onClose={onClose}
      onDraftChange={intake.setDraft}
      onSend={() => {
        void intake.send().catch(() => undefined);
      }}
      placeholder="回答 AI 的问题，或补充简历、项目信息…"
      sending={intake.opening || (intake.sendPending && !intake.activeMessageId)}
      stealth={false}
      streaming={Boolean(intake.activeMessageId)}
      title="制作面试分身"
      variant="interview"
    />
  );
}
