import type { DesktopBridge, ReplyBarAction, ReplyBarState } from "@answra/shared";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { FloatingBar } from "../components/floating-bar/FloatingBar";
import { FloatingLayerHost } from "../components/floating-bar/FloatingLayerHost";
import { type ChatAttachment, type ChatMessage, ChatPanel } from "../components/panels/ChatPanel";
import { NotesPanel } from "../components/panels/NotesPanel";
import { ReplyBar } from "../components/panels/ReplyBar";
import { SettingsPanel } from "../components/panels/SettingsPanel";
import { SourcesPanel } from "../components/panels/SourcesPanel";
import { useFitContent } from "../hooks/useFitContent";
import { useMeetingStealth } from "../hooks/useMeetingStealth";
import { MODES, type Mode, type ModeAction, NOTE_STORAGE_KEY, WELCOME_MESSAGE } from "../model";
import { useAppearanceController } from "./useAppearanceController";
import { useSurfaceCoordinator } from "./useSurfaceCoordinator";

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
  const surfaces = useSurfaceCoordinator();
  const { panel, workflow, floatingLayers } = surfaces;
  const [messages] = useState<ChatMessage[]>([
    { id: "welcome", role: "assistant", content: WELCOME_MESSAGE },
  ]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const replyPhase = workflow?.phase ?? "closed";
  /** 流式展示中的 AI 回复文本。 */
  const [replyText, setReplyText] = useState("");
  /** 截图失败原因：屏幕可见的错误提示，避免失败被静默吞掉、只看到胶囊。 */
  const [note, setNote] = useState(() => localStorage.getItem(NOTE_STORAGE_KEY) ?? "");
  const [sources, setSources] = useState<string[]>([]);
  const appearance = useAppearanceController(platform);
  const stealthSetting = useMeetingStealth(platform);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replyWindowWasOpen = useRef(false);
  const replyActionHandler = useRef<(action: ReplyBarAction) => void>(() => undefined);
  const detachedReplyBar = typeof platform?.setReplyBarState === "function";
  // The hidden toolbar keeps its last native bounds while the reply workflow
  // owns a separate HWND; measuring its temporarily empty shell would shrink it.
  const { ref: shellRef } = useFitContent(platform, !detachedReplyBar || replyPhase === "closed");

  const readReplyBarState = useCallback((): ReplyBarState => {
    const root = document.documentElement;
    const computed = getComputedStyle(root);
    const variables: Record<string, string> = {};
    for (let index = 0; index < computed.length; index += 1) {
      const name = computed.item(index);
      if (name.startsWith("--")) variables[name] = computed.getPropertyValue(name).trim();
    }
    variables["--fade"] = root.style.getPropertyValue("--fade") || "1";
    return {
      phase: replyPhase === "streaming" ? "streaming" : "composing",
      attachments,
      draft,
      replyText,
      stealth: stealthSetting.enabled,
      theme: { scheme: root.dataset.theme, variables },
    };
  }, [attachments, draft, replyPhase, replyText, stealthSetting.enabled]);

  useEffect(() => {
    if (!detachedReplyBar) return;
    if (replyPhase === "closed") {
      if (replyWindowWasOpen.current) {
        platform?.setReplyBarState?.(null);
        replyWindowWasOpen.current = false;
      }
      return;
    }
    replyWindowWasOpen.current = true;
    platform?.setReplyBarState?.(readReplyBarState());
  }, [detachedReplyBar, platform, readReplyBarState, replyPhase]);

  useEffect(() => {
    if (!detachedReplyBar || replyPhase === "closed") return;
    const observer = new MutationObserver(() => {
      platform?.setReplyBarState?.(readReplyBarState());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    return () => observer.disconnect();
  }, [detachedReplyBar, platform, readReplyBarState, replyPhase]);

  function toggleModeMenu() {
    if (surfaces.layer === "mode-menu") surfaces.closeFloatingLayers();
    else surfaces.openModeMenu();
  }

  /** 触发区域截图；桌面端由主进程框选，无桥时回落文件选择。 */
  function triggerScreenshot() {
    const startCapture = platform?.startRegionCapture;
    if (startCapture) {
      void startRegionCapture(startCapture);
    } else {
      surfaces.startWorkflow();
      window.setTimeout(() => fileInputRef.current?.click(), 0);
    }
  }

  function handleModeAction(action: ModeAction) {
    if (action.id === "screenshot") {
      triggerScreenshot();
      return;
    }
    if (action.id === "record") {
      surfaces.openPanel("notes");
      return;
    }
    surfaces.openPanel("chat");
  }

  async function startRegionCapture(
    startCapture: NonNullable<DesktopBridge["startRegionCapture"]>,
  ) {
    console.log("[reply] 触发区域截图");
    try {
      const result = await startCapture({ line: readInkColor() });
      console.log("[reply] 截图结果:", result);
      // 失败：取消是用户主动行为不打扰；其余失败屏幕可见，便于排查根因
      if (result.ok === false) {
        if (result.reason !== "cancelled") {
          surfaces.dispatch({
            type: "layer/show-notice",
            id: "capture-error",
            message: result.message ?? "截图失败，请重试",
          });
        }
        return;
      }
      // 截图回复是持久任务工作流：独占内容表面槽，结束后恢复此前打开的面板。
      surfaces.startWorkflow();
      console.log("[reply] 进入回复条预备区，追加截图附件");
      setAttachments((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          name: `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
          previewUrl: result.dataUrl,
        },
      ]);
      setDraft((current) => current || SCREENSHOT_PROMPT);
    } catch (error) {
      console.error("[reply] 截图桥调用异常:", error);
      surfaces.dispatch({
        type: "layer/show-notice",
        id: "capture-error",
        message: "截图调用异常，请查看终端日志",
      });
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

  /** 关闭任务工作流；桌面端关闭独立回复窗口并恢复主工具栏。 */
  function closeReplyBar() {
    clearPending();
    surfaces.finishWorkflow();
    setReplyText("");
  }

  function performSend() {
    const content = draft.trim();
    if (!content && attachments.length === 0) return;

    // 回复条不走对话面板：发送后整条进入流式态，匀速滚动演示回复；
    // 预备截图已“发出”，释放 blob 预览并清空预备区。
    const sent = attachments;
    sent.forEach((candidate) => {
      if (candidate.previewUrl.startsWith("blob:")) URL.revokeObjectURL(candidate.previewUrl);
    });
    setReplyText(
      `演示回复：已收到${sent.length ? ` ${sent.length} 张截图` : ""}${content ? "与你的补充问题" : ""}。当前尚未连接 AI 服务；接入本地 API 后，这条横条会以匀速滚动的方式显示实际分析结果。`,
    );
    surfaces.dispatch({ type: "workflow/phase", phase: "streaming" });
    setDraft("");
    setAttachments([]);
  }

  replyActionHandler.current = (action) => {
    switch (action.type) {
      case "draft/change":
        setDraft(action.value);
        break;
      case "attachment/add":
        setAttachments((current) => [...current, action.attachment]);
        setDraft((current) => current || SCREENSHOT_PROMPT);
        break;
      case "attachment/remove":
        removeAttachment(action.id);
        break;
      case "screenshot/start":
        triggerScreenshot();
        break;
      case "send":
        performSend();
        break;
      case "close":
        closeReplyBar();
        break;
    }
  };

  useEffect(() => {
    if (!detachedReplyBar) return;
    return platform?.onReplyBarAction?.((action) => replyActionHandler.current(action));
  }, [detachedReplyBar, platform]);

  function saveNote(value: string) {
    setNote(value);
    localStorage.setItem(NOTE_STORAGE_KEY, value);
  }

  return (
    <main
      className="overlay-root"
      data-stealth={stealthSetting.enabled ? "true" : undefined}
      ref={shellRef}
    >
      {/* 专注发送态：回复条激活期间胶囊退场，全屏只留一条发送条 */}
      {replyPhase === "closed" && (
        <FloatingBar
          modeMenuOpen={surfaces.layer === "mode-menu"}
          mode={mode}
          modes={MODES}
          onClose={() => platform?.close()}
          onModeAction={handleModeAction}
          onModeChange={setMode}
          onDismissModeMenu={surfaces.closeFloatingLayers}
          onToggleModeMenu={toggleModeMenu}
          onTogglePanel={surfaces.togglePanel}
          panel={panel}
        />
      )}

      <FloatingLayerHost layers={floatingLayers} onDismiss={surfaces.dismissFloatingLayer} />

      {panel === "chat" && (
        <ChatPanel
          attachments={attachments}
          draft={draft}
          fileInputRef={fileInputRef}
          messages={messages}
          onAttachmentChange={handleAttachmentChange}
          onAttachmentRemove={removeAttachment}
          onClose={() => surfaces.openPanel("closed")}
          onDraftChange={setDraft}
          onSend={performSend}
        />
      )}

      {replyPhase !== "closed" && !detachedReplyBar && (
        <ReplyBar
          attachments={attachments}
          draft={draft}
          fileInputRef={fileInputRef}
          phase={replyPhase}
          replyText={replyText}
          onAttachmentChange={handleAttachmentChange}
          onAttachmentRemove={removeAttachment}
          onClose={closeReplyBar}
          onDraftChange={setDraft}
          onScreenshot={triggerScreenshot}
          onSend={performSend}
        />
      )}

      {panel === "notes" && (
        <NotesPanel
          note={note}
          onClose={() => surfaces.openPanel("closed")}
          onNoteChange={saveNote}
        />
      )}

      {panel === "sources" && (
        <SourcesPanel
          onClose={() => surfaces.openPanel("closed")}
          onSourcesChange={setSources}
          sources={sources}
        />
      )}

      {panel === "settings" && (
        <SettingsPanel
          ambientFollow={appearance.ambientFollow}
          onAmbientFollowChange={appearance.setAmbientFollow}
          onClose={() => surfaces.openPanel("closed")}
          onOpacityChange={appearance.setOpacity}
          onStealthChange={stealthSetting.setEnabled}
          opacity={appearance.opacity}
          stealth={stealthSetting.enabled}
          stealthSupported={stealthSetting.supported}
        />
      )}
    </main>
  );
}
