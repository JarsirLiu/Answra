import type { DesktopBridge } from "@exam-assistant/shared";
import { type ChangeEvent, useRef, useState } from "react";
import { FloatingBar } from "../components/floating-bar/FloatingBar";
import { type ChatAttachment, type ChatMessage, ChatPanel } from "../components/panels/ChatPanel";
import { NotesPanel } from "../components/panels/NotesPanel";
import { SettingsPanel } from "../components/panels/SettingsPanel";
import { SourcesPanel } from "../components/panels/SourcesPanel";
import { useFitContent } from "../hooks/useFitContent";
import {
  MODES,
  type Mode,
  type ModeAction,
  NOTE_STORAGE_KEY,
  type Panel,
  WELCOME_MESSAGE,
} from "../model";

const SCREENSHOT_PROMPT = "请帮我分析这道题，先说明题意和解题思路。";

interface FloatingBarAppProps {
  /** 桌面平台桥；默认使用 preload 注入的 window.examAssistant，测试可注入 mock。 */
  bridge?: DesktopBridge;
}

export function FloatingBarApp({ bridge }: FloatingBarAppProps) {
  // 默认桥由 desktop preload 注入（window.examAssistant），浏览器预览与测试可传入 mock
  const platform = bridge ?? (globalThis as { examAssistant?: DesktopBridge }).examAssistant;
  const [mode, setMode] = useState<Mode>("exam");
  const [panel, setPanel] = useState<Panel>("closed");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "welcome", role: "assistant", content: WELCOME_MESSAGE },
  ]);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [note, setNote] = useState(() => localStorage.getItem(NOTE_STORAGE_KEY) ?? "");
  const [sources, setSources] = useState<string[]>([]);
  const [localOnly, setLocalOnly] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { ref: shellRef } = useFitContent(platform);

  function openPanel(next: Panel) {
    setPanel(next);
  }

  function togglePanel(target: Exclude<Panel, "closed">) {
    openPanel(panel === target ? "closed" : target);
  }

  function handleModeAction(action: ModeAction) {
    if (action.id === "screenshot") {
      openPanel("chat");
      window.setTimeout(() => fileInputRef.current?.click(), 0);
      return;
    }
    if (action.id === "record") {
      openPanel("notes");
      return;
    }
    openPanel("chat");
  }

  function handleAttachmentChange(input: ChangeEvent<HTMLInputElement> | File | null) {
    const file = input instanceof File ? input : (input?.target.files?.[0] ?? null);
    if (!file || !file.type.startsWith("image/")) return;
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
    setAttachment({ name: file.name, previewUrl: URL.createObjectURL(file) });
    setDraft((current) => current || SCREENSHOT_PROMPT);
  }

  function removeAttachment() {
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
    setAttachment(null);
  }

  function performSend() {
    const content = draft.trim();
    if (!content && !attachment) return;

    const screenshot = attachment;
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        content,
        ...(screenshot && {
          attachment: { name: screenshot.name, previewUrl: screenshot.previewUrl },
        }),
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "演示回复：已收到截图和补充消息。当前尚未连接 AI 服务；接入本地 API 后，这里会显示实际分析结果。",
      },
    ]);
    setDraft("");
    setAttachment(null);
  }

  function saveNote(value: string) {
    setNote(value);
    localStorage.setItem(NOTE_STORAGE_KEY, value);
  }

  const modeLabel = MODES.find((item) => item.id === mode)?.label ?? "";

  return (
    <main className="overlay-root" ref={shellRef}>
      <FloatingBar
        mode={mode}
        modes={MODES}
        onClose={() => platform?.close()}
        onModeAction={handleModeAction}
        onModeChange={setMode}
        onTogglePanel={togglePanel}
        panel={panel}
      />

      {panel === "chat" && (
        <ChatPanel
          attachment={attachment}
          draft={draft}
          fileInputRef={fileInputRef}
          messages={messages}
          modeLabel={modeLabel}
          onAttachmentChange={handleAttachmentChange}
          onAttachmentRemove={removeAttachment}
          onClose={() => openPanel("closed")}
          onDraftChange={setDraft}
          onSend={performSend}
        />
      )}

      {panel === "notes" && (
        <NotesPanel
          modeLabel={modeLabel}
          note={note}
          onClose={() => openPanel("closed")}
          onNoteChange={saveNote}
        />
      )}

      {panel === "sources" && (
        <SourcesPanel
          modeLabel={modeLabel}
          onClose={() => openPanel("closed")}
          onSourcesChange={setSources}
          sources={sources}
        />
      )}

      {panel === "settings" && (
        <SettingsPanel
          localOnly={localOnly}
          modeLabel={modeLabel}
          onClose={() => openPanel("closed")}
          onLocalOnlyChange={setLocalOnly}
        />
      )}
    </main>
  );
}
