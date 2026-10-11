import type { DesktopBridge, ReplyBarAction, ReplyBarState } from "@answra/shared";
import { useEffect, useRef, useState } from "react";
import { ReplyBar } from "../components/panels/ReplyBar";
import { useFitContent } from "../hooks/useFitContent";

interface ReplyBarWindowAppProps {
  bridge?: DesktopBridge;
}

/** Independent renderer for the task workflow; the toolbar renderer owns state. */
export function ReplyBarWindowApp({ bridge }: ReplyBarWindowAppProps) {
  const platform = bridge ?? (globalThis as { answra?: DesktopBridge }).answra;
  const [state, setState] = useState<ReplyBarState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const measureBridge = platform?.fitReplyBar ? { fitContent: platform.fitReplyBar } : undefined;
  const { ref } = useFitContent(measureBridge);

  useEffect(() => {
    const unsubscribe = platform?.onReplyBarState?.(setState);
    platform?.requestReplyBarState?.();
    return unsubscribe;
  }, [platform]);

  useEffect(() => {
    if (!state) return;
    const root = document.documentElement;
    root.dataset.theme = state.theme.scheme ?? "light";
    for (const [name, value] of Object.entries(state.theme.variables)) {
      root.style.setProperty(name, value);
    }
    root.style.setProperty("--fade", state.theme.variables["--fade"] ?? "1");
  }, [state]);

  if (!state) return <main aria-hidden="true" className="reply-window-root" ref={ref} />;

  const send = (action: ReplyBarAction) => platform?.sendReplyBarAction?.(action);

  return (
    <main className="reply-window-root" data-stealth={state.stealth ? "true" : undefined} ref={ref}>
      <ReplyBar
        attachments={state.attachments}
        draft={state.draft}
        fileInputRef={fileInputRef}
        phase={state.phase}
        replyText={state.replyText}
        onAttachmentChange={(file) => {
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === "string") {
              send({
                type: "attachment/add",
                attachment: {
                  id: crypto.randomUUID(),
                  name: file.name,
                  previewUrl: reader.result,
                },
              });
            }
          };
          reader.readAsDataURL(file);
        }}
        onAttachmentRemove={(id) => send({ type: "attachment/remove", id })}
        onClose={() => send({ type: "close" })}
        onCancel={() => send({ type: "cancel" })}
        onScreenshot={() => send({ type: "screenshot/start" })}
        onSend={() => send({ type: "send" })}
      />
    </main>
  );
}
