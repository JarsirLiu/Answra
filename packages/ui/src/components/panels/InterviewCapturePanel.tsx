import { AudioLines, CircleAlert, LoaderCircle, Mic, Square } from "lucide-react";
import type { InterviewCapturePort, InterviewCaptureState } from "../../app/interviewCapture";
import { ICON, ICON_STROKE } from "../../tokens";
import { SurfaceButton } from "../controls/SurfaceButton";
import { PanelShell } from "./PanelShell";
import "./InterviewCapturePanel.css";

interface InterviewCapturePanelProps {
  capture?: InterviewCapturePort;
  state: InterviewCaptureState;
  onClose: () => void;
}

export function InterviewCapturePanel({ capture, state, onClose }: InterviewCapturePanelProps) {
  const running =
    state.phase === "starting" || state.phase === "listening" || state.phase === "stopping";
  const status =
    state.phase === "starting"
      ? "正在连接系统声音和麦克风"
      : state.phase === "listening"
        ? "正在采集系统声音和麦克风"
        : state.phase === "stopping"
          ? "正在停止采集"
          : state.phase === "error"
            ? (state.message ?? "采集失败")
            : "未开始";
  const StatusIcon =
    state.phase === "starting" || state.phase === "stopping"
      ? LoaderCircle
      : state.phase === "listening"
        ? AudioLines
        : state.phase === "error"
          ? CircleAlert
          : Mic;

  return (
    <PanelShell
      title="面试语音测试"
      variant="interview"
      context={state.phase === "listening" ? "Windows" : undefined}
      onClose={onClose}
    >
      <div className="interview-capture-content">
        <div aria-live="polite" className="interview-capture-status">
          <StatusIcon
            aria-hidden="true"
            className="interview-capture-status-icon"
            size={ICON}
            strokeWidth={ICON_STROKE}
          />
          <span>{status}</span>
        </div>
        <div className="interview-capture-actions">
          {running ? (
            <SurfaceButton
              className="interview-capture-button"
              disabled={state.phase === "stopping" || !capture}
              onClick={() => void capture?.stop()}
              type="button"
            >
              <Square aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
              停止采集
            </SurfaceButton>
          ) : (
            <SurfaceButton
              className="interview-capture-button"
              disabled={!capture}
              onClick={() => void capture?.start()}
              type="button"
            >
              <Mic aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
              开始采集
            </SurfaceButton>
          )}
        </div>
        <p aria-live="polite" className="interview-capture-note">
          {state.phase === "listening"
            ? "音频已送达识别链路；转写文字会在语音片段结束后显示。"
            : "同时识别会议声音和麦克风。"}
        </p>
        <ol aria-label="实时转录" className="interview-transcript-list" aria-live="polite">
          {(state.transcripts ?? []).map((line) => (
            <li className="interview-transcript-line" key={line.id}>
              <div className="interview-transcript-meta">
                <span>{line.speaker === "interviewer" ? "对方" : "我"}</span>
                <time dateTime={new Date(line.timestamp).toISOString()}>
                  {new Date(line.timestamp).toLocaleTimeString()}
                </time>
                {line.turnEnd && line.speaker === "interviewer" && (
                  <span className="interview-turn-end">检测到对方停顿</span>
                )}
              </div>
              <p>{line.text || "（未识别出文字）"}</p>
            </li>
          ))}
        </ol>
      </div>
    </PanelShell>
  );
}
