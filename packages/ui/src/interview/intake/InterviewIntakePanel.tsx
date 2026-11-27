/** 面试分身 intake 对话页：普通消息流与输入框，不额外定义制作状态。 */
import type { DesktopBridge } from "@answra/shared";
import { useRef } from "react";
import { SurfaceButton } from "../../components/controls/SurfaceButton";
import { ChatPanel } from "../../components/panels/ChatPanel";
import { useInterviewIntake } from "./useInterviewIntake";

interface InterviewIntakePanelProps {
  platform: DesktopBridge | undefined;
  onBackToModes: () => void;
  onClose: () => void;
  onReopenOnboarding: () => Promise<void>;
}

export function InterviewIntakePanel({
  platform,
  onBackToModes,
  onClose,
  onReopenOnboarding,
}: InterviewIntakePanelProps) {
  const intake = useInterviewIntake(platform);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const headerAction = (
    <>
      {intake.error && intake.messages.length === 0 ? (
        <SurfaceButton onClick={intake.retryOpen} variant="quiet">
          重试
        </SurfaceButton>
      ) : null}
      <SurfaceButton onClick={onBackToModes} variant="quiet">
        返回
      </SurfaceButton>
      <SurfaceButton
        onClick={() => {
          void onReopenOnboarding().catch(() => undefined);
        }}
        variant="quiet"
      >
        资料
      </SurfaceButton>
    </>
  );

  return (
    <ChatPanel
      attachments={intake.attachments}
      bridge={platform}
      draft={intake.draft}
      error={intake.error}
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
      title="面试分身"
      variant="interview"
    />
  );
}
