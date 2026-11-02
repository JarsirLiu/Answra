import { FloatingBarApp, MarkdownWindowApp, ReplyBarWindowApp } from "@answra/ui";
import { createRoot } from "react-dom/client";
import "@answra/ui/styles.css";
import { InterviewAudioCapture } from "./interviewAudioCapture";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 挂载点");

const isReplySurface = new URLSearchParams(window.location.search).get("surface") === "reply";
const isMarkdownSurface = new URLSearchParams(window.location.search).get("surface") === "markdown";
createRoot(container).render(
  isMarkdownSurface ? (
    <MarkdownWindowApp bridge={window.answra} />
  ) : isReplySurface ? (
    <ReplyBarWindowApp />
  ) : (
    <FloatingBarApp
      interviewCapture={__ANSWRA_FEATURE_INTERVIEW__ ? new InterviewAudioCapture() : undefined}
    />
  ),
);
