import {
  ActiveChatConversationId,
  ActiveExamConversationId,
  type DesktopAnnouncement,
  type DesktopBridge,
} from "@answra/shared";
import { useEffect, useState } from "react";
import { FloatingBar } from "../components/floating-bar/FloatingBar";
import { FloatingLayerHost } from "../components/floating-bar/FloatingLayerHost";
import { AnnouncementPanel } from "../components/panels/AnnouncementPanel";
import { ChatPanel } from "../components/panels/ChatPanel";
import { ReplyBar } from "../components/panels/ReplyBar";
import { SettingsPanel } from "../components/panels/SettingsPanel";
import { WorkspacePanel } from "../components/panels/workspace/WorkspacePanel";
import { useFitContent } from "../hooks/useFitContent";
import { useMeetingStealth } from "../hooks/useMeetingStealth";
import { useStealthInputGuard } from "../hooks/useStealthInputGuard";
import { MODES, type Mode, type ModeAction } from "../model";
import { useAppearanceController } from "./useAppearanceController";
import { useGeneralChat, useScreenshotAnswer } from "./useConversationChat";
import { useReplyWorkflow } from "./useReplyWorkflow";
import { useSurfaceCoordinator } from "./useSurfaceCoordinator";

interface FloatingBarAppProps {
  /** 桌面平台桥；默认使用 preload 注入的 window.answra，测试可注入 mock。 */
  bridge?: DesktopBridge;
}

export function FloatingBarApp({ bridge }: FloatingBarAppProps) {
  // 默认桥由 desktop preload 注入（window.answra），浏览器预览与测试可传入 mock
  const platform = bridge ?? (globalThis as { answra?: DesktopBridge }).answra;
  const [mode, setMode] = useState<Mode>("conversation");
  const [announcements, setAnnouncements] = useState<DesktopAnnouncement[]>([]);
  const [authSignedIn, setAuthSignedIn] = useState(false);
  const surfaces = useSurfaceCoordinator();
  const { panel, workflow, floatingLayers } = surfaces;
  const replyPhase = workflow?.phase ?? "closed";
  /** 截图失败原因：屏幕可见的错误提示，避免失败被静默吞掉、只看到胶囊。 */
  const appearance = useAppearanceController(platform);
  const stealthSetting = useMeetingStealth(platform);
  useStealthInputGuard(stealthSetting.enabled);
  const conversation = useGeneralChat(platform, ActiveChatConversationId);
  const answer = useScreenshotAnswer(platform, ActiveExamConversationId);
  useEffect(() => {
    if (!platform?.getAuthStatus) return;
    let cancelled = false;
    let statusVersion = 0;
    const sync = (signedIn: boolean) => {
      const version = ++statusVersion;
      setAuthSignedIn(signedIn);
      if (!signedIn || !platform.getAnnouncements) {
        setAnnouncements([]);
        return;
      }
      void platform
        .getAnnouncements()
        .then((items) => {
          if (!cancelled && version === statusVersion) setAnnouncements(items);
        })
        .catch(() => undefined);
    };
    void platform
      .getAuthStatus()
      .then((status) => {
        if (!cancelled && statusVersion === 0) sync(status.signedIn);
      })
      .catch(() => undefined);
    const unsubscribe = platform.onAuthStatus?.((status) => sync(status.signedIn));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [platform]);
  useEffect(() => {
    if (!authSignedIn || !platform?.getAnnouncements) return;
    let cancelled = false;
    const timer = setInterval(
      () => {
        void platform
          .getAnnouncements?.()
          .then((items) => {
            if (!cancelled) setAnnouncements(items);
          })
          .catch(() => undefined);
      },
      5 * 60 * 1000,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [authSignedIn, platform]);
  useEffect(() => {
    if (panel !== "chat" && replyPhase === "closed") answer.clearMessages();
  }, [answer.clearMessages, panel, replyPhase]);
  const reply = useReplyWorkflow({
    cancelMessage: answer.cancel,
    onCaptureError: (message) =>
      surfaces.dispatch({ type: "layer/show-notice", id: "capture-error", message }),
    onWorkflowFinish: () => {
      answer.clearMessages();
      surfaces.finishWorkflow();
    },
    onWorkflowPhase: (phase) => surfaces.dispatch({ type: "workflow/phase", phase }),
    onWorkflowStart: surfaces.startWorkflow,
    phase: replyPhase,
    platform,
    replyText: answer.replyText,
    replyActivities: answer.replyActivities,
    replyError: answer.replyError,
    replyPending: answer.replyPending,
    sendMessage: answer.send,
    stealth: stealthSetting.enabled,
  });
  const {
    attachments,
    closeReplyBar,
    detachedReplyBar,
    draft,
    fileInputRef,
    handleAttachmentChange,
    performSend,
    removeAttachment,
    replyText,
    replyActivities,
    replyError,
    setDraft,
    setAttachments,
    triggerScreenshot,
  } = reply;
  // The hidden toolbar keeps its last native bounds while the reply workflow
  // owns a separate HWND; measuring its temporarily empty shell would shrink it.
  const { ref: shellRef } = useFitContent(platform, !detachedReplyBar || replyPhase === "closed");

  function toggleModeMenu() {
    if (surfaces.layer === "mode-menu") surfaces.closeFloatingLayers();
    else surfaces.openModeMenu();
  }

  function handleModeAction(action: ModeAction) {
    if (action.id === "screenshot") {
      triggerScreenshot();
      return;
    }
    if (action.id === "chat") surfaces.openPanel("chat");
  }

  function handleModeChange(nextMode: Mode) {
    setMode(nextMode);
    if (nextMode === "conversation") surfaces.openPanel("chat");
    else if (panel === "chat") surfaces.openPanel("closed");
  }

  /** 按需回显已保存的 API Key；桥未实现（浏览器预览/测试）时无此能力。 */
  const getConversationApiKey = platform?.getConversationApiKey?.bind(platform);
  const revealApiKey = getConversationApiKey ? () => getConversationApiKey() : undefined;

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
          onModeChange={handleModeChange}
          onDismissModeMenu={surfaces.closeFloatingLayers}
          onToggleModeMenu={toggleModeMenu}
          onTogglePanel={surfaces.togglePanel}
          unreadAnnouncements={announcements.filter((item) => !item.readAt).length}
          showAnnouncements={authSignedIn}
          panel={panel}
        />
      )}

      <FloatingLayerHost layers={floatingLayers} onDismiss={surfaces.dismissFloatingLayer} />

      {panel === "chat" && (
        <ChatPanel
          bridge={platform}
          stealth={stealthSetting.enabled}
          attachments={attachments}
          draft={draft}
          fileInputRef={fileInputRef}
          streaming={Boolean(conversation.activeRunId)}
          thinkingMs={conversation.thinkingMs}
          messages={conversation.messages}
          onCancel={conversation.cancel}
          onAttachmentChange={handleAttachmentChange}
          onAttachmentRemove={removeAttachment}
          onClose={() => {
            surfaces.openPanel("closed");
          }}
          onDraftChange={setDraft}
          onVote={(vote) =>
            surfaces.dispatch({
              type: "layer/show-notice",
              id: "conversation-vote",
              message: vote === "up" ? "感谢反馈！" : "已收到反馈，我们会继续改进",
            })
          }
          onSend={() => {
            // 发送即清空输入框与附件；失败时恢复草稿，避免丢失输入。
            const sentDraft = draft;
            const sentAttachments = attachments;
            setDraft("");
            setAttachments([]);
            void conversation
              .send(sentDraft, sentAttachments)
              .then(() => reply.clearPending())
              .catch((error: unknown) => {
                setDraft(sentDraft);
                setAttachments(sentAttachments);
                surfaces.dispatch({
                  type: "layer/show-notice",
                  id: "conversation-error",
                  message: error instanceof Error ? error.message : "发送失败",
                });
              });
          }}
        />
      )}

      {replyPhase !== "closed" && !detachedReplyBar && (
        <ReplyBar
          attachments={attachments}
          draft={draft}
          fileInputRef={fileInputRef}
          phase={replyPhase}
          replyText={replyText}
          replyActivities={replyActivities}
          replyError={replyError}
          replyPending={answer.replyPending}
          onAttachmentChange={handleAttachmentChange}
          onAttachmentRemove={removeAttachment}
          onClose={closeReplyBar}
          onCancel={reply.cancelReply}
          onScreenshot={triggerScreenshot}
          onSend={performSend}
        />
      )}

      {panel === "notes" && (
        <WorkspacePanel
          bridge={platform}
          onClose={() => {
            surfaces.openPanel("closed");
          }}
          stealth={stealthSetting.enabled}
        />
      )}

      {panel === "settings" && (
        <SettingsPanel
          bridge={platform}
          ambientFollow={appearance.ambientFollow}
          modelConfig={conversation.config}
          onModelConfigSave={conversation.configure}
          onRevealApiKey={revealApiKey}
          onAmbientFollowChange={appearance.setAmbientFollow}
          onClose={() => surfaces.openPanel("closed")}
          onOpacityChange={appearance.setOpacity}
          onStealthChange={stealthSetting.setEnabled}
          opacity={appearance.opacity}
          stealth={stealthSetting.enabled}
          stealthSupported={stealthSetting.supported}
        />
      )}

      {panel === "announcements" && (
        <AnnouncementPanel
          announcements={announcements}
          onClose={() => surfaces.openPanel("closed")}
          onMarkRead={async (id) => {
            if (!platform?.markAnnouncementRead) throw new Error("当前版本不支持公告操作");
            await platform.markAnnouncementRead(id);
            const readAt = new Date().toISOString();
            setAnnouncements((items) =>
              items.map((item) => (item.id === id ? { ...item, readAt } : item)),
            );
          }}
        />
      )}
    </main>
  );
}
