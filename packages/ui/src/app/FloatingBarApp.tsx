import type { DesktopBridge } from "@answra/shared";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { FloatingBar } from "../components/floating-bar/FloatingBar";
import { type ChatAttachment, type ChatMessage, ChatPanel } from "../components/panels/ChatPanel";
import { NotesPanel } from "../components/panels/NotesPanel";
import { ReplyBar } from "../components/panels/ReplyBar";
import { SettingsPanel } from "../components/panels/SettingsPanel";
import { SourcesPanel } from "../components/panels/SourcesPanel";
import { useFitContent } from "../hooks/useFitContent";
import {
  AMBIENT_FOLLOW_STORAGE_KEY,
  APP_OPACITY_STORAGE_KEY,
  MODES,
  type Mode,
  type ModeAction,
  NOTE_STORAGE_KEY,
  type Panel,
  STEALTH_STORAGE_KEY,
  WELCOME_MESSAGE,
} from "../model";
import { type ColorGroupOverrides, loadColorGroups, useAppTheme } from "../theme";

const SCREENSHOT_PROMPT = "请帮我分析这道题，先说明题意和解题思路。";

/**
 * 读取当前主题墨色（--ink 的解析值）作为框选虚线颜色：
 * 变色龙/深浅模式/用户透明度变化时自动联动，无需在 overlay 侧再算色。
 */
function readInkColor(): string | undefined {
  const probe = document.createElement("span");
  probe.style.color = "var(--ink)";
  probe.style.display = "none";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || undefined;
}

interface FloatingBarAppProps {
  /** 桌面平台桥；默认使用 preload 注入的 window.answra，测试可注入 mock。 */
  bridge?: DesktopBridge;
}

export function FloatingBarApp({ bridge }: FloatingBarAppProps) {
  // 默认桥由 desktop preload 注入（window.answra），浏览器预览与测试可传入 mock
  const platform = bridge ?? (globalThis as { answra?: DesktopBridge }).answra;
  const [mode, setMode] = useState<Mode>("exam");
  const [panel, setPanel] = useState<Panel>("closed");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "welcome", role: "assistant", content: WELCOME_MESSAGE },
  ]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  /** 原地回复条是否展开（截图提问走这里，不复用对话面板）。 */
  const [replyOpen, setReplyOpen] = useState(false);
  const [note, setNote] = useState(() => localStorage.getItem(NOTE_STORAGE_KEY) ?? "");
  const [sources, setSources] = useState<string[]>([]);
  const [ambientFollow, setAmbientFollow] = useState(
    () => localStorage.getItem(AMBIENT_FOLLOW_STORAGE_KEY) === "on",
  );
  const [opacity, setOpacity] = useState(() => {
    const stored = Number(localStorage.getItem(APP_OPACITY_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 0.5 && stored <= 1 ? stored : 1;
  });
  const [stealth, setStealth] = useState(() => localStorage.getItem(STEALTH_STORAGE_KEY) === "on");
  /** 系统是否可靠支持隐身；null 表示查询中，未确认前不应用隐身。 */
  const [stealthSupported, setStealthSupported] = useState<boolean | null>(null);
  const [colorGroups] = useState<ColorGroupOverrides>(loadColorGroups);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { ref: shellRef } = useFitContent(platform);
  useAppTheme(platform, { ambientFollow, colorGroups });

  // fade 是唯一透明度自由度：tokens.css 中所有感知令牌是它的函数。
  // 必须写在 :root（与令牌声明同元素），写到子元素不会触发自定义属性重算。
  useEffect(() => {
    document.documentElement.style.setProperty("--fade", String(opacity));
    return () => {
      document.documentElement.style.removeProperty("--fade");
    };
  }, [opacity]);

  // 查询系统能力：旧 Windows 捕获到黑块而非排除，Linux 无等价能力，
  // 这些系统不允许开启隐身（settings 中禁用开关）
  useEffect(() => {
    let cancelled = false;
    platform
      ?.getStealthSupport?.()
      .then((supported) => {
        if (!cancelled) setStealthSupported(supported);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [platform]);

  // 会议隐身：开启后屏幕共享/截图捕获不到本窗口，并从任务栏/Dock、
  // Alt+Tab/Cmd+Tab 隐藏；自身屏幕仍可见。仅桌面端且系统支持时应用；
  // 能力未确认（null）前不调用，避免旧系统在查询完成前误开内容保护。
  useEffect(() => {
    if (stealthSupported === null || !stealthSupported) return;
    platform?.setStealth?.(stealth);
  }, [stealth, platform, stealthSupported]);

  function setAmbientFollowPersisted(value: boolean) {
    setAmbientFollow(value);
    localStorage.setItem(AMBIENT_FOLLOW_STORAGE_KEY, value ? "on" : "off");
  }

  function setOpacityPersisted(value: number) {
    setOpacity(value);
    localStorage.setItem(APP_OPACITY_STORAGE_KEY, String(value));
  }

  function setStealthPersisted(value: boolean) {
    setStealth(value);
    localStorage.setItem(STEALTH_STORAGE_KEY, value ? "on" : "off");
  }

  function openPanel(next: Panel) {
    setPanel(next);
  }

  function togglePanel(target: Exclude<Panel, "closed">) {
    openPanel(panel === target ? "closed" : target);
  }

  function handleModeAction(action: ModeAction) {
    if (action.id === "screenshot") {
      // 桌面端走主进程区域截图（框选 overlay）；浏览器预览/测试无桥，回落文件选择
      const startCapture = platform?.startRegionCapture;
      if (startCapture) {
        void startRegionCapture(startCapture);
      } else {
        // 无捕获桥（浏览器预览/测试）：回落到文件选择，仍走原地回复条
        setReplyOpen(true);
        window.setTimeout(() => fileInputRef.current?.click(), 0);
      }
      return;
    }
    if (action.id === "record") {
      openPanel("notes");
      return;
    }
    openPanel("chat");
  }

  async function startRegionCapture(
    startCapture: NonNullable<DesktopBridge["startRegionCapture"]>,
  ) {
    try {
      const result = await startCapture({ line: readInkColor() });
      // 取消/失败静默收场，不弹回复条
      if (!result.ok) return;
      setReplyOpen(true);
      setAttachments((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          name: `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
          previewUrl: result.dataUrl,
        },
      ]);
      setDraft((current) => current || SCREENSHOT_PROMPT);
    } catch {
      // 桥调用异常同样静默
    }
  }

  function handleAttachmentChange(input: ChangeEvent<HTMLInputElement> | File | null) {
    const file = input instanceof File ? input : (input?.target.files?.[0] ?? null);
    if (!file?.type.startsWith("image/")) return;
    setAttachments((current) => [
      ...current,
      { id: crypto.randomUUID(), name: file.name, previewUrl: URL.createObjectURL(file) },
    ]);
    setDraft((current) => current || SCREENSHOT_PROMPT);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const target = current.find((candidate) => candidate.id === id);
      if (target?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(target.previewUrl);
      return current.filter((candidate) => candidate.id !== id);
    });
  }

  /** 取消发送：清空本轮未发送的消息（截图 + 草稿），并释放 blob URL。 */
  function clearPending() {
    setAttachments((current) => {
      current.forEach((candidate) => {
        if (candidate.previewUrl.startsWith("blob:")) URL.revokeObjectURL(candidate.previewUrl);
      });
      return [];
    });
    setDraft("");
  }

  /** 关闭回复条等同放弃本轮未发送内容。 */
  function closeReplyBar() {
    clearPending();
    setReplyOpen(false);
  }

  function performSend() {
    const content = draft.trim();
    if (!content && attachments.length === 0) return;

    // 快照当前预备附件：发送后它们归属到消息，回复条内已清空（不在此 revoke，避免消息图失效）
    const sent = attachments;
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        content,
        attachments: sent,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "演示回复：已收到截图和补充消息。当前尚未连接 AI 服务；接入本地 API 后，这里会显示实际分析结果。",
      },
    ]);
    setDraft("");
    setAttachments([]);
  }

  function saveNote(value: string) {
    setNote(value);
    localStorage.setItem(NOTE_STORAGE_KEY, value);
  }

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
          attachments={attachments}
          draft={draft}
          fileInputRef={fileInputRef}
          messages={messages}
          onAttachmentChange={handleAttachmentChange}
          onAttachmentRemove={removeAttachment}
          onClose={() => openPanel("closed")}
          onDraftChange={setDraft}
          onSend={performSend}
        />
      )}

      {replyOpen && (
        <ReplyBar
          attachments={attachments}
          draft={draft}
          fileInputRef={fileInputRef}
          messages={messages}
          onAttachmentChange={handleAttachmentChange}
          onAttachmentRemove={removeAttachment}
          onClearAll={clearPending}
          onClose={closeReplyBar}
          onDraftChange={setDraft}
          onSend={performSend}
        />
      )}

      {panel === "notes" && (
        <NotesPanel note={note} onClose={() => openPanel("closed")} onNoteChange={saveNote} />
      )}

      {panel === "sources" && (
        <SourcesPanel
          onClose={() => openPanel("closed")}
          onSourcesChange={setSources}
          sources={sources}
        />
      )}

      {panel === "settings" && (
        <SettingsPanel
          ambientFollow={ambientFollow}
          onAmbientFollowChange={setAmbientFollowPersisted}
          onClose={() => openPanel("closed")}
          onOpacityChange={setOpacityPersisted}
          onStealthChange={setStealthPersisted}
          opacity={opacity}
          stealth={stealth && stealthSupported === true}
          stealthSupported={stealthSupported === true}
        />
      )}
    </main>
  );
}
