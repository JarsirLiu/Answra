import {
  ActiveChatConversationId,
  ActiveExamConversationId,
  AUTH_REQUIRED_NOTICE,
  type DesktopAnnouncement,
  type DesktopBridge,
  isAuthRequiredError,
} from "@answra/shared";
import { useEffect, useState } from "react";
import { FloatingBar } from "../components/floating-bar/FloatingBar";
import { FloatingLayerHost } from "../components/floating-bar/FloatingLayerHost";
import { ChatPanel } from "../components/panels/ChatPanel";
import { InterviewCapturePanel } from "../components/panels/InterviewCapturePanel";
import { ReplyBar } from "../components/panels/ReplyBar";
import { ReplyDetails } from "../components/panels/ReplyDetails";
import { SettingsPanel } from "../components/panels/SettingsPanel";
import { WorkspacePanel } from "../components/panels/workspace/WorkspacePanel";
import { useFitContent } from "../hooks/useFitContent";
import { useMeetingStealth } from "../hooks/useMeetingStealth";
import { useStealthInputGuard } from "../hooks/useStealthInputGuard";
import { useSurfaceWidth } from "../hooks/useSurfaceWidth";
import { MODES, type Mode, type ModeAction } from "../model";
import type { InterviewCapturePort, InterviewCaptureState } from "./interviewCapture";
import { useAppearanceController } from "./useAppearanceController";
import { useGeneralChat, useScreenshotAnswer } from "./useConversationChat";
import { useReplyDetail } from "./useReplyDetail";
import { useReplyWorkflow } from "./useReplyWorkflow";
import { useSurfaceCoordinator } from "./useSurfaceCoordinator";

interface FloatingBarAppProps {
  /** 桌面平台桥；默认使用 preload 注入的 window.answra，测试可注入 mock。 */
  bridge?: DesktopBridge;
  interviewCapture?: InterviewCapturePort;
}

/** 一次模型调用失败：统一提示的文案，以及是否要给出「去登录」按钮。 */
interface SendFailure {
  message: string;
  needsSignIn: boolean;
}

export function FloatingBarApp({ bridge, interviewCapture }: FloatingBarAppProps) {
  // 默认桥由 desktop preload 注入（window.answra），浏览器预览与测试可传入 mock
  const platform = bridge ?? (globalThis as { answra?: DesktopBridge }).answra;
  const [mode, setMode] = useState<Mode>("conversation");
  const [announcements, setAnnouncements] = useState<DesktopAnnouncement[]>([]);
  const [authSignedIn, setAuthSignedIn] = useState(false);
  const [interviewCaptureState, setInterviewCaptureState] = useState<InterviewCaptureState>(
    interviewCapture?.getState() ?? { phase: "idle" },
  );
  const surfaces = useSurfaceCoordinator();
  const { panel, floatingLayers, featureSlot } = surfaces;
  const replyPhase = featureSlot.kind === "reply" ? (featureSlot.phase ?? "composing") : "closed";
  /** 截图失败原因：屏幕可见的错误提示，避免失败被静默吞掉、只看到胶囊。 */
  const appearance = useAppearanceController(platform);
  const stealthSetting = useMeetingStealth(platform);
  useStealthInputGuard(stealthSetting.enabled);
  const conversation = useGeneralChat(platform, ActiveChatConversationId);
  const answer = useScreenshotAnswer(platform, ActiveExamConversationId);
  const [chatFailure, setChatFailure] = useState<SendFailure>();
  const [replyFailure, setReplyFailure] = useState<SendFailure>();
  useEffect(() => {
    if (!platform?.getAuthStatus) return;
    let cancelled = false;
    let statusVersion = 0;
    const sync = (signedIn: boolean) => {
      const version = ++statusVersion;
      setAuthSignedIn(signedIn);
      // 登录成功即清掉上一轮「请先登录」提示：原因已经不存在了。
      if (signedIn) {
        setChatFailure(undefined);
        setReplyFailure(undefined);
      }
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
    if (!interviewCapture) return;
    setInterviewCaptureState(interviewCapture.getState());
    return interviewCapture.subscribe(setInterviewCaptureState);
  }, [interviewCapture]);
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
  // 失败提示属于本轮对话：离开对话面板即丢弃，重新打开不会压着上一轮的错误。
  useEffect(() => {
    if (panel !== "chat") setChatFailure(undefined);
  }, [panel]);
  const reply = useReplyWorkflow({
    cancelMessage: answer.cancel,
    onCaptureError: (message) =>
      surfaces.dispatch({ type: "layer/show-notice", id: "capture-error", message }),
    onEnterReply: (origin) => surfaces.enterReply(origin),
    onExitReply: () => {
      answer.clearMessages();
      surfaces.exitReply();
    },
    onSendError: (error) => notifySendError("reply", error),
    onSetReplyPhase: (phase) => surfaces.setReplyPhase(phase),
    phase: replyPhase,
    platform,
    replyText: answer.replyText,
    replyActivities: answer.replyActivities,
    // 传输层失败也要进入回复条状态：内联回复条与独立回复窗共用同一份失败展示。
    replyError: replyFailure?.message ?? answer.replyError,
    replyPending: answer.replyPending,
    sendMessage: answer.send,
    stealth: stealthSetting.enabled,
    inline: true,
  });
  const {
    attachments,
    closeReplyBar,
    conversationId,
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
  // 回复详情展开态：导航条下方弹出本轮对话流（composing 时自动折叠）。
  const replyDetail = useReplyDetail(replyPhase);
  // 功能槽占用态：回复工作流激活时，导航条右侧（功能段 + 工作区段）整段换成发送条/回复条。
  const replyFeatureSlot =
    featureSlot.kind === "reply" ? (
      <ReplyBar
        embedded
        attachments={attachments}
        draft={draft}
        fileInputRef={fileInputRef}
        phase={featureSlot.phase ?? "composing"}
        replyText={replyText}
        replyActivities={replyActivities}
        replyError={replyError}
        replyPending={answer.replyPending}
        showConversationToggle
        conversationExpanded={replyDetail.expanded}
        onToggleConversation={replyDetail.toggle}
        onAttachmentChange={handleAttachmentChange}
        onAttachmentRemove={removeAttachment}
        onClose={closeReplyBar}
        onCancel={reply.cancelReply}
        onSignIn={replyFailure?.needsSignIn ? () => signIn("reply") : undefined}
        onScreenshot={triggerScreenshot}
        onSend={() => {
          // 重新发送即清掉上一轮的失败提示，避免旧错误压着新结果。
          setReplyFailure(undefined);
          performSend();
        }}
      />
    ) : undefined;
  // 主窗口内联形态（inline）下 detachedReplyBar 恒为 false，shell 始终需要测量。
  const { ref: shellRef } = useFitContent(platform, true);
  // 对话/回复面板宽度跟随悬浮导航栏，两者默认同宽。
  useSurfaceWidth(shellRef);

  function toggleModeMenu() {
    if (surfaces.layer === "mode-menu") surfaces.closeFloatingLayers();
    else surfaces.openModeMenu();
  }

  /**
   * 模型调用失败的统一呈现：把失败留在发起它的那个表面（对话正文末尾 / 回复条），
   * 不再另弹浮层横条。未登录时收敛为同一句登录提示，并附一个「去登录」按钮——
   * 失败本身不自动拉起浏览器，只有用户点按钮才去登录。
   */
  function toFailure(error: unknown): SendFailure {
    return isAuthRequiredError(error)
      ? { message: AUTH_REQUIRED_NOTICE, needsSignIn: true }
      : { message: error instanceof Error ? error.message : "发送失败", needsSignIn: false };
  }

  function notifySendError(target: "chat" | "reply", error: unknown) {
    if (target === "chat") setChatFailure(toFailure(error));
    else setReplyFailure(toFailure(error));
  }

  /** 「去登录」：原地换成打开结果，避免点了没反应。 */
  function signIn(target: "chat" | "reply") {
    const setFailure = target === "chat" ? setChatFailure : setReplyFailure;
    const pending = platform?.loginAccount?.();
    if (!pending) return;
    void pending
      .then((result) => {
        if (!result.opened) {
          setFailure({ message: result.error ?? "无法打开授权页", needsSignIn: true });
        }
      })
      .catch((error: unknown) => {
        setFailure({
          message: error instanceof Error ? error.message : "登录失败",
          needsSignIn: true,
        });
      });
  }

  // 对话面板的失败来源有两个：发送被拒（chatFailure）与本轮流式 error chunk（conversation.replyError）。
  // 两者共用一个展示位，传输层失败优先。
  const chatFailureMessage = chatFailure?.message ?? conversation.replyError;
  const chatNeedsSignIn =
    Boolean(chatFailure?.needsSignIn) || isAuthRequiredError(conversation.replyError);

  function handleModeAction(action: ModeAction) {
    if (action.id === "screenshot") {
      triggerScreenshot();
      return;
    }
    if (action.id === "chat") {
      if (featureSlot.kind === "reply") surfaces.exitReply();
      else surfaces.openPanel("chat");
    }
    if (action.id === "capture") surfaces.openPanel("interview");
  }

  function handleModeChange(nextMode: Mode) {
    // 回复工作流期间切换模式：先退出回复槽，避免功能槽与外壳 panel 状态打架。
    if (featureSlot.kind === "reply") closeReplyBar();
    setMode(nextMode);
    if (nextMode === "conversation") surfaces.openPanel("chat");
    else if (panel === "chat" || panel === "interview") surfaces.openPanel("closed");
  }

  return (
    <main
      className="overlay-root"
      data-stealth={stealthSetting.enabled ? "true" : undefined}
      ref={shellRef}
    >
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
        panel={panel}
        featureSlot={replyFeatureSlot}
      />

      <FloatingLayerHost layers={floatingLayers} onDismiss={surfaces.dismissFloatingLayer} />

      {panel === "chat" && featureSlot.kind === "chat" && (
        <ChatPanel
          bridge={platform}
          stealth={stealthSetting.enabled}
          attachments={attachments}
          draft={draft}
          error={chatFailureMessage}
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
          onSignIn={chatNeedsSignIn ? () => signIn("chat") : undefined}
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
            setChatFailure(undefined);
            void conversation
              .send(sentDraft, sentAttachments)
              .then(() => reply.clearPending())
              .catch((error: unknown) => {
                setDraft(sentDraft);
                setAttachments(sentAttachments);
                notifySendError("chat", error);
              });
          }}
        />
      )}

      {panel === "interview" && (
        <InterviewCapturePanel
          capture={interviewCapture}
          state={interviewCaptureState}
          onClose={() => surfaces.openPanel("closed")}
        />
      )}

      {featureSlot.kind === "reply" ? (
        <ReplyDetails
          bridge={platform}
          conversationId={conversationId}
          enabled={Boolean(conversationId)}
          expanded={replyDetail.expanded}
          stealth={stealthSetting.enabled}
        />
      ) : null}

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
          onAmbientFollowChange={appearance.setAmbientFollow}
          onClose={() => surfaces.openPanel("closed")}
          onOpacityChange={appearance.setOpacity}
          onStealthChange={stealthSetting.setEnabled}
          opacity={appearance.opacity}
          stealth={stealthSetting.enabled}
          stealthSupported={stealthSetting.supported}
          announcements={announcements}
          unreadAnnouncements={announcements.filter((item) => !item.readAt).length}
          signedIn={authSignedIn}
          onMarkAnnouncementRead={async (id) => {
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
