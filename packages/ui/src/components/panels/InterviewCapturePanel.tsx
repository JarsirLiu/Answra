import { AudioLines, CircleAlert, LoaderCircle, Mic } from "lucide-react";
import { useState } from "react";
import type { InterviewCapturePort, InterviewCaptureState } from "../../app/interviewCapture";
import { INTERVIEW_INPUT_LEVEL_WINDOW } from "../../app/interviewCapture";
import type { InterviewMessageView } from "../../app/interviewConversation";
import { ICON, ICON_SM, ICON_STROKE } from "../../tokens";
import { MessageStream, ModelErrorNotice } from "../chat";
import "../chat/conversation.css";
import { ConversationComposer } from "./ConversationComposer";
import { PanelShell } from "./PanelShell";
import "./InterviewCapturePanel.css";

interface InterviewCapturePanelProps {
  capture?: InterviewCapturePort;
  state: InterviewCaptureState;
  messages: readonly InterviewMessageView[];
  onSendText: (text: string) => Promise<void>;
  /** 清空当前面试对话历史；缺省不显示入口。 */
  onClear?: () => void;
  /** 清空不可用的原因（没有历史）；设置即禁用按钮并以 title 提示。 */
  clearDisabledReason?: string;
  error?: string;
  onClose: () => void;
}

export function InterviewCapturePanel({
  capture,
  state,
  messages,
  onSendText,
  onClear,
  clearDisabledReason,
  error,
  onClose,
}: InterviewCapturePanelProps) {
  const [draft, setDraft] = useState("");
  const running =
    state.phase === "starting" || state.phase === "listening" || state.phase === "stopping";
  // 助手回复期间 store 会拒绝追加 user 消息；这里按消息状态禁用发送，
  // 让用户保留草稿，而不是提交后才看到「当前回复尚未完成」。
  const replying = messages.some(
    (message) => message.role === "assistant" && message.status === "streaming",
  );
  // 采集状态行只在有状态可看时出现；空闲时说明收敛到消息区空态，不占常驻两行。
  const status =
    state.phase === "starting"
      ? "正在连接麦克风"
      : state.phase === "listening"
        ? "正在监听麦克风"
        : state.phase === "stopping"
          ? "正在停止采集"
          : state.phase === "error"
            ? (state.message ?? "采集失败")
            : null;
  const StatusIcon =
    state.phase === "starting" || state.phase === "stopping"
      ? LoaderCircle
      : state.phase === "listening"
        ? AudioLines
        : CircleAlert;
  // 内容指纹与 ChatPanel 同构：error 出现或更新也要能滚到可见位置。
  const contentKey = [
    ...messages.map((message) => `${message.id}:${message.text.length}:${message.status}`),
    error ?? "",
  ].join("|");
  const emptyHint =
    state.phase === "idle" ? "点击下方麦克风开始语音输入。" : "识别完成后会加入对话并生成回复。";
  // 波形铺满输入区：窗口不足时不收缩宽度，以静默槽位补齐左侧历史。
  const levelBars = state.inputLevels?.length
    ? [
        ...Array.from(
          { length: Math.max(0, INTERVIEW_INPUT_LEVEL_WINDOW - state.inputLevels.length) },
          () => 0,
        ),
        ...state.inputLevels,
      ]
    : Array.from({ length: INTERVIEW_INPUT_LEVEL_WINDOW }, () => 0);

  return (
    <PanelShell
      headerAction={
        onClear ? (
          <button
            aria-label={clearDisabledReason ?? "清空对话历史"}
            className="panel-header-action surface-control surface-control--quiet"
            disabled={Boolean(clearDisabledReason)}
            onClick={onClear}
            type="button"
          >
            清空
          </button>
        ) : undefined
      }
      title="面试对话"
      variant="interview"
      onClose={onClose}
    >
      <div className="interview-capture-content">
        {status && (
          <div aria-live="polite" className="interview-capture-status">
            <StatusIcon
              aria-hidden="true"
              className="interview-capture-status-icon"
              size={ICON}
              strokeWidth={ICON_STROKE}
            />
            <span>{status}</span>
          </div>
        )}
        <MessageStream
          ariaLabel="面试对话消息"
          contentKey={contentKey}
          viewportClassName="conversation"
        >
          {messages.map((message) => (
            <article className={`chat-message chat-message--${message.role}`} key={message.id}>
              {message.role === "assistant" && message.status === "interrupted" && (
                <span className="interview-message-status">已中断</span>
              )}
              <div className="message-content">
                {message.text ||
                  (message.role === "assistant" && message.status === "streaming"
                    ? "正在回复…"
                    : "")}
              </div>
            </article>
          ))}
          {error && <ModelErrorNotice message={error} />}
          {messages.length === 0 && !error && (
            <p className="interview-capture-empty">{emptyHint}</p>
          )}
        </MessageStream>
      </div>
      <ConversationComposer
        inputLabel="面试消息"
        placeholder="输入消息…"
        value={draft}
        onValueChange={setDraft}
        onSubmit={() => {
          const text = draft.trim();
          if (!text || replying) return;
          // 只有追加成功才清草稿；失败时保留输入，用户可直接重试。
          void onSendText(text)
            .then(() => setDraft(""))
            .catch(() => undefined);
        }}
        submitDisabled={!draft.trim() || replying}
        showAttachmentButton={false}
        liveContent={
          running ? (
            <div aria-label="麦克风实时音量" className="interview-audio-wave" role="img">
              {levelBars.map((level, index) => (
                <span
                  aria-hidden="true"
                  className="interview-audio-wave-bar"
                  // biome-ignore lint/suspicious/noArrayIndexKey: 滑动电平窗口按位置渲染，槽位本身就是元素身份
                  key={`wave-${index}`}
                  style={{ height: `${Math.round(level * 100)}%` }}
                />
              ))}
            </div>
          ) : undefined
        }
        leadingAction={
          running ? undefined : (
            <button
              aria-label="开始麦克风监听"
              className="conversation-composer-icon-button"
              disabled={!capture}
              onClick={() => void capture?.start()}
              type="button"
            >
              <Mic aria-hidden="true" size={ICON_SM} />
            </button>
          )
        }
        streaming={running}
        streamingStopLabel="停止语音输入"
        onStop={() => void capture?.stop()}
      />
    </PanelShell>
  );
}
