import { FloatingBarApp, ReplyBarWindowApp } from "@answra/ui";
import { createRoot } from "react-dom/client";
import "@answra/ui/styles.css";
import { InterviewAudioCapture } from "./interviewAudioCapture";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 挂载点");

const isReplySurface = new URLSearchParams(window.location.search).get("surface") === "reply";
createRoot(container).render(
  isReplySurface ? (
    <ReplyBarWindowApp />
  ) : (
    <FloatingBarApp interviewCapture={new InterviewAudioCapture()} />
  ),
);
