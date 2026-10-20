import { FloatingBarApp, ImeCandidateWindowApp, ReplyBarWindowApp } from "@answra/ui";
import { createRoot } from "react-dom/client";
import "@answra/ui/styles.css";
import { InterviewAudioCapture } from "./interviewAudioCapture";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 挂载点");

const isReplySurface = new URLSearchParams(window.location.search).get("surface") === "reply";
const isImeCandidateSurface =
  new URLSearchParams(window.location.search).get("surface") === "ime-candidate";
createRoot(container).render(
  isImeCandidateSurface ? (
    <ImeCandidateWindowApp />
  ) : isReplySurface ? (
    <ReplyBarWindowApp />
  ) : (
    <FloatingBarApp interviewCapture={new InterviewAudioCapture()} />
  ),
);
