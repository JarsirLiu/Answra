import { FloatingBarApp, ReplyBarWindowApp, SurfaceWindowApp } from "@answra/ui";
import { createRoot } from "react-dom/client";
import "@answra/ui/styles.css";
import { InterviewAudioCapture } from "./interviewAudioCapture";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 挂载点");

const surfaceKind = new URLSearchParams(window.location.search).get("surface");
createRoot(container).render(
  surfaceKind === "reply" ? (
    <ReplyBarWindowApp />
  ) : surfaceKind === "surface" ? (
    <SurfaceWindowApp />
  ) : (
    <FloatingBarApp
      interviewCapture={__ANSWRA_FEATURE_INTERVIEW__ ? new InterviewAudioCapture() : undefined}
    />
  ),
);
