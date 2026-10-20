import { Mic, Square } from "lucide-react";
import type { InterviewCapturePort, InterviewCaptureState } from "../../app/interviewCapture";
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
      ? "正在连接系统声音"
      : state.phase === "listening"
        ? "正在采集系统声音"
        : state.phase === "stopping"
          ? "正在停止采集"
          : state.phase === "error"
            ? (state.message ?? "采集失败")
            : "未开始";

  return (
    <PanelShell
      title="系统声音采集"
      variant="interview"
      context={state.phase === "listening" ? "Windows" : undefined}
      onClose={onClose}
    >
      <div className="interview-capture-content">
        <div aria-live="polite" className="interview-capture-status">
          <span
            aria-hidden="true"
            className={`interview-capture-indicator interview-capture-indicator--${state.phase}`}
          />
          <span>{status}</span>
        </div>
        <div className="interview-capture-actions">
          {running ? (
            <button
              className="interview-capture-button interview-capture-button--stop"
              disabled={state.phase === "stopping" || !capture}
              onClick={() => void capture?.stop()}
              type="button"
            >
              <Square aria-hidden="true" size={15} />
              停止采集
            </button>
          ) : (
            <button
              className="interview-capture-button"
              disabled={!capture}
              onClick={() => void capture?.start()}
              type="button"
            >
              <Mic aria-hidden="true" size={16} />
              开始采集
            </button>
          )}
        </div>
        <p className="interview-capture-note">当前仅采集系统声音，转录和回答尚未接入。</p>
      </div>
    </PanelShell>
  );
}
