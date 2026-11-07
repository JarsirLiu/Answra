import {
  ActiveExamConversationId,
  ActiveInterviewConversationId,
  AUTH_REQUIRED_NOTICE,
  type DesktopAnnouncement,
  type DesktopBridge,
  isAuthRequiredError,
} from "@answra/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { TooltipProvider } from "../components/controls/Tooltip";
import { FloatingBar } from "../components/floating-bar/FloatingBar";
import { FloatingLayerHost } from "../components/floating-bar/FloatingLayerHost";
import { InterviewCapturePanel } from "../components/panels/InterviewCapturePanel";
import { ReplyBar } from "../components/panels/ReplyBar";
import { ReplyDetails } from "../components/panels/ReplyDetails";
import { SettingsPanel } from "../components/panels/SettingsPanel";
import { useFitContent } from "../hooks/useFitContent";
import { useMeetingStealth } from "../hooks/useMeetingStealth";
import { useStealthDocumentFlag } from "../hooks/useStealthDocumentFlag";
import { useStealthInputGuard } from "../hooks/useStealthInputGuard";
import { useSurfaceWidth } from "../hooks/useSurfaceWidth";
import { ANSWER_MODE, applyModeAvailability, MODES, type Mode, type ModeAction } from "../model";
import { ChatFeaturePanel } from "./ChatFeaturePanel";
import type { InterviewCapturePort, InterviewCaptureState } from "./interviewCapture";
import { useAppearanceController } from "./useAppearanceController";
import { useScreenshotAnswer } from "./useConversationChat";
import { useInterviewConversation } from "./useInterviewConversation";
import { useReplyDetail } from "./useReplyDetail";
import { useReplyWorkflow } from "./useReplyWorkflow";
import { useSurfaceCoordinator } from "./useSurfaceCoordinator";

const WorkspaceFeaturePanel = __ANSWRA_FEATURE_WORKSPACE__
  ? lazy(() =>
      import("./WorkspaceFeaturePanel").then((module) => ({
        default: module.WorkspaceFeaturePanel,
      })),
    )
  : undefined;

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
  const { view: interviewConversation, reconcileSnapshot: reconcileInterviewSnapshot } =
    useInterviewConversation(platform, ActiveInterviewConversationId);
  const [interviewError, setInterviewError] = useState<string>();
  const lastInterviewMessage = interviewConversation.messages.at(-1);
  const interviewReplyId =
    lastInterviewMessage?.role === "assistant" ? lastInterviewMessage.id : undefined;
  // 自动回复真正开始后，手动发送留下的旧错误已经过期；只清 transcript 侧
  // 的错误不够，因为这里的 interviewError 优先级更高。
  useEffect(() => {
    if (interviewReplyId || interviewConversation.activeRunId) setInterviewError(undefined);
  }, [interviewConversation.activeRunId, interviewReplyId]);
  const surfaces = useSurfaceCoordinator();
  const { panel, floatingLayers, featureSlot } = surfaces;
  const replyPhase = featureSlot.kind === "reply" ? (featureSlot.phase ?? "composing") : "closed";
  /** 截图失败原因：屏幕可见的错误提示，避免失败被静默吞掉、只看到胶囊。 */
  const appearance = useAppearanceController(platform);
  const stealthSetting = useMeetingStealth(platform);
  useStealthDocumentFlag(stealthSetting.enabled);
  useStealthInputGuard(stealthSetting.enabled);
  const modes =
    __ANSWRA_FEATURE_CHAT__ || __ANSWRA_FEATURE_INTERVIEW__
      ? applyModeAvailability(MODES, {
          interview: __ANSWRA_FEATURE_INTERVIEW__ && platform?.interviewAvailable !== false,
        })
      : [ANSWER_MODE];
  const answer = useScreenshotAnswer(platform, ActiveExamConversationId);
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
    if (!__ANSWRA_FEATURE_INTERVIEW__) return;
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
  const reply = useReplyWorkflow({
    cancelMessage: answer.cancel,
    onCaptureError: (message) =>
      surfaces.dispatch({ type: "layer/show-notice", id: "capture-error", message }),
    onEnterReply: (origin) => surfaces.enterReply(origin),
    onExitReply: () => {
      answer.clearMessages();
      surfaces.exitReply();
    },
    onSendError: notifySendError,
    onSetReplyPhase: (phase) => surfaces.setReplyPhase(phase),
    phase: replyPhase,
    platform,
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
    draft,
    exitReply,
    fileInputRef,
    handleAttachmentChange,
    performSend,
    removeAttachment,
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
        onSignIn={replyFailure?.needsSignIn ? signInReply : undefined}
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

  function notifySendError(error: unknown) {
    setReplyFailure(toFailure(error));
  }

  /** 「去登录」：原地换成打开结果，避免点了没反应。 */
  function signInReply() {
    const pending = platform?.loginAccount?.();
    if (!pending) return;
    void pending
      .then((result) => {
        if (!result.opened) {
          setReplyFailure({ message: result.error ?? "无法打开授权页", needsSignIn: true });
        }
      })
      .catch((error: unknown) => {
        setReplyFailure({
          message: error instanceof Error ? error.message : "登录失败",
          needsSignIn: true,
        });
      });
  }

  function handleModeAction(action: ModeAction) {
    if (action.id === "screenshot") {
      triggerScreenshot();
      return;
    }
    if (action.id === "chat") {
      if (featureSlot.kind === "reply") exitReply();
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

  /** 清空常驻会话并同步清理本地投影。 */
  function clearConversation(conversationId: string) {
    void platform?.clearConversationMessages?.(conversationId).catch((error: unknown) =>
      surfaces.dispatch({
        type: "layer/show-notice",
        id: "conversation-clear",
        message: error instanceof Error ? error.message : "清空失败，请稍后再试",
      }),
    );
  }

  return (
    <TooltipProvider stealth={stealthSetting.enabled}>
      <main
        className="overlay-root"
        data-stealth={stealthSetting.enabled ? "true" : undefined}
        ref={shellRef}
      >
        <FloatingBar
          modeMenuOpen={surfaces.layer === "mode-menu"}
          mode={mode}
          modes={modes}
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

        {__ANSWRA_FEATURE_CHAT__ && (
          <ChatFeaturePanel
            visible={panel === "chat" && featureSlot.kind === "chat"}
            bridge={platform}
            signedIn={authSignedIn}
            stealth={stealthSetting.enabled}
            attachments={attachments}
            draft={draft}
            fileInputRef={fileInputRef}
            onDraftChange={setDraft}
            onAttachmentChange={handleAttachmentChange}
            onAttachmentsChange={setAttachments}
            onAttachmentRemove={removeAttachment}
            onConversationCleared={clearConversation}
            onClose={() => surfaces.openPanel("closed")}
            onVote={(vote) =>
              surfaces.dispatch({
                type: "layer/show-notice",
                id: "conversation-vote",
                message: vote === "up" ? "感谢反馈！" : "已收到反馈，我们会继续改进",
              })
            }
            onSent={reply.clearPending}
          />
        )}

        {__ANSWRA_FEATURE_INTERVIEW__ && panel === "interview" && (
          <InterviewCapturePanel
            capture={interviewCapture}
            state={interviewCaptureState}
            messages={interviewConversation.messages}
            retry={interviewConversation.retry}
            error={interviewError ?? interviewConversation.error}
            onSendText={async (text) => {
              setInterviewError(undefined);
              if (!platform?.appendConversationUserMessage)
                throw new Error("当前版本不支持发送消息");
              try {
                const snapshot = await platform.appendConversationUserMessage(
                  ActiveInterviewConversationId,
                  text,
                );
                await reconcileInterviewSnapshot(snapshot);
              } catch (error) {
                setInterviewError(error instanceof Error ? error.message : "消息发送失败");
                throw error;
              }
            }}
            onClear={
              platform?.clearConversationMessages
                ? () => clearConversation(ActiveInterviewConversationId)
                : undefined
            }
            clearDisabledReason={
              interviewConversation.messages.length === 0 ? "本场还没有对话" : undefined
            }
            onClose={() => surfaces.openPanel("closed")}
          />
        )}

        {featureSlot.kind === "reply" ? (
          <ReplyDetails
            bridge={platform}
            conversation={answer}
            error={replyFailure?.message}
            expanded={replyDetail.expanded}
            stealth={stealthSetting.enabled}
          />
        ) : null}

        {__ANSWRA_FEATURE_WORKSPACE__ && panel === "notes" && WorkspaceFeaturePanel && (
          <Suspense fallback={null}>
            <WorkspaceFeaturePanel
              bridge={platform}
              onClose={() => surfaces.openPanel("closed")}
              stealth={stealthSetting.enabled}
            />
          </Suspense>
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
    </TooltipProvider>
  );
}
