import type { AgentConnectionState } from "@answra/shared";
import { AudioLines, CircleAlert, Keyboard, LoaderCircle, Mic } from "lucide-react";
import { useState } from "react";
import type { InterviewCapturePort, InterviewCaptureState } from "../../app/interviewCapture";
import { INTERVIEW_INPUT_LEVEL_WINDOW } from "../../app/interviewCapture";
import { ICON, ICON_SM, ICON_STROKE } from "../../tokens";
import {
  AssistantMessage,
  ConnectionNotice,
  formatConnectionNotice,
  MessageStream,
  ModelErrorNotice,
  RetryNotice,
} from "../chat";
import {
  type ConversationRetry,
  type ConversationViewMessage,
  partsContentKey,
} from "../chat/conversationMessage";
import { SurfaceButton } from "../controls/SurfaceButton";
import "../chat/conversation.css";
import { ConversationComposer } from "./ConversationComposer";
import { PanelShell } from "./PanelShell";
import "./InterviewCapturePanel.css";

interface InterviewCapturePanelProps {
  capture?: InterviewCapturePort;
  state: InterviewCaptureState;
  messages: readonly ConversationViewMessage[];
  retry?: ConversationRetry;
  /** Agent worker 链路状态；与模型重试/错误互斥展示。 */
  connection?: AgentConnectionState;
  onSendText: (text: string) => Promise<void>;
  /** 空白会话的启动入口；点击后由调用方代替用户发送固定消息。 */
  onStartRehearsal?: () => Promise<void>;
  /** 取消正在流式输出的助手回复。 */
  onCancel?: () => void;
  /** 清空当前演练对话历史；缺省不显示入口。 */
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
  retry,
  connection,
  onSendText,
  onStartRehearsal,
  onCancel,
  onClear,
  clearDisabledReason,
  error,
  onClose,
}: InterviewCapturePanelProps) {
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
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
  const visibleMessages = messages.filter((message) => {
    const hasToolPart = message.parts?.some((part) => part.kind === "tool") ?? false;
    return !(
      message.role === "assistant" &&
      message.status === "interrupted" &&
      !message.text &&
      !message.reasoning &&
      !message.activities?.length &&
      !hasToolPart
    );
  });
  const connectionNotice = formatConnectionNotice(connection);
  // 内容指纹与 ChatPanel 同构：error 出现或更新也要能滚到可见位置。
  const contentKey = [
    ...messages.map(
      (message) =>
        `${message.id}:${message.text.length}:${message.status}:${partsContentKey(message.parts)}`,
    ),
    retry ? `retry:${retry.attempt}/${retry.maxRetries}` : "",
    error ?? "",
    connection ? `connection:${connection.revision}` : "",
  ].join("|");
  const emptyHint =
    state.phase === "idle"
      ? "先让我检查你的面试记忆和简历，再开始演练。"
      : "回答会加入对话，面试官会继续追问。";
  const startRehearsal = () => {
    if (!onStartRehearsal || starting || replying) return;
    setStarting(true);
    void onStartRehearsal()
      .catch(() => undefined)
      .finally(() => setStarting(false));
  };
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
  const cancellingReply = replying && Boolean(onCancel);
  const streamingStopLabel = running ? "停止语音输入" : "停止回复";
  const stopStreaming = running ? () => void capture?.stop() : onCancel;

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
      title="面试演练"
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
          ariaLabel="面试演练消息"
          contentKey={contentKey}
          viewportClassName="conversation"
        >
          {visibleMessages.map((message) => (
            <article className={`chat-message chat-message--${message.role}`} key={message.id}>
              {message.role === "user" ? (
                <div className="message-content">{message.text}</div>
              ) : (
                <>
                  {message.waitingForStream && (
                    <div aria-label="回复运行中" className="conversation-running" role="status">
                      <LoaderCircle
                        aria-hidden="true"
                        className="conversation-running-icon"
                        size={15}
                      />
                    </div>
                  )}
                  <AssistantMessage
                    caret={message.status === "streaming" && Boolean(message.text)}
                    content={message.text}
                    parts={message.parts}
                    reasoning={message.reasoning}
                    streaming={message.status === "streaming"}
                    thinking={message.thinking === true}
                  />
                </>
              )}
            </article>
          ))}
          <ConnectionNotice state={connection} />
          {!connectionNotice && retry && <RetryNotice retry={retry} />}
          {!connectionNotice && error && <ModelErrorNotice message={error} />}
          {visibleMessages.length === 0 && !error && !connectionNotice && (
            <div className="interview-capture-empty">
              <p>{emptyHint}</p>
              {onStartRehearsal && (
                <SurfaceButton
                  disabled={starting || replying || running}
                  onClick={startRehearsal}
                  variant="primary"
                >
                  {starting ? "正在开始…" : "开始面试演练"}
                </SurfaceButton>
              )}
            </div>
          )}
        </MessageStream>
      </div>
      <ConversationComposer
        inputLabel="演练消息"
        placeholder="输入你的回答…"
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
          running ? (
            <button
              aria-label="切换到打字"
              className="conversation-composer-icon-button"
              disabled={!capture || state.phase === "stopping"}
              onClick={() => void capture?.stop()}
              title="切换到打字"
              type="button"
            >
              <Keyboard aria-hidden="true" size={ICON_SM} />
            </button>
          ) : (
            <button
              aria-label="开始演练麦克风监听"
              className="conversation-composer-icon-button"
              disabled={!capture}
              onClick={() => void capture?.start()}
              type="button"
            >
              <Mic aria-hidden="true" size={ICON_SM} />
            </button>
          )
        }
        streaming={running || cancellingReply}
        streamingStopLabel={streamingStopLabel}
        onStop={stopStreaming}
      />
    </PanelShell>
  );
}
