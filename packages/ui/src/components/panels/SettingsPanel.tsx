import type {
  AuthStatus,
  ConversationModelSettingsView,
  ConversationModelSource,
  DesktopAnnouncement,
  DesktopBridge,
} from "@answra/shared";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { RangeSlider } from "../controls/RangeSlider";
import { SurfaceButton } from "../controls/SurfaceButton";
import { Switch } from "../controls/Switch";
import { AnnouncementList } from "./AnnouncementList";
import { PanelShell, type PanelTab } from "./PanelShell";
import "./SettingsPanel.css";

type SettingsTab = "account" | "settings" | "announcements";

const TAB_TITLES: Record<SettingsTab, string> = {
  account: "账户",
  settings: "设置",
  announcements: "公告",
};

interface SettingsPanelProps {
  bridge?: DesktopBridge;
  /** 是否跟随屏幕背景自动变色（变色龙主题）；开启时表面随背景、深浅方案随背景亮度自动决定。 */
  ambientFollow: boolean;
  /** 前景透明度（0.5~1）；文字/图标/描边随之变化，表面恒不透明。 */
  opacity: number;
  stealth: boolean;
  /** 系统是否可靠支持隐身（内容保护）；不支持时开关禁用。 */
  stealthSupported: boolean;
  onAmbientFollowChange: (value: boolean) => void;
  onOpacityChange: (value: number) => void;
  onStealthChange: (value: boolean) => void;
  /** 公告数据与操作；数据由已登录状态拉取，列表内自持错误状态。 */
  announcements: DesktopAnnouncement[];
  unreadAnnouncements: number;
  signedIn: boolean;
  onMarkAnnouncementRead: (id: number) => Promise<void>;
  onClose: () => void;
}

const OPACITY_MIN = 0.5;
const OPACITY_MAX = 1;

/** 档位标识由服务端下发；已知档位给中文名，未知档位原样展示，不猜语义。 */
const PLAN_LABELS: Record<string, string> = { free: "免费档", pro: "会员" };

function accountTitle(status: AuthStatus | null): string {
  if (!status?.signedIn) return "未登录";
  if (!status.plan) return "已登录";
  return PLAN_LABELS[status.plan] ?? status.plan;
}

/** 账号标识优先用邮箱，其次用户名；两者都缺失时不渲染。 */
function accountIdentity(status: AuthStatus | null): string {
  if (!status?.signedIn) return "";
  return status.account?.email || status.account?.username || "";
}

/** 设置面板：面板头部即 账户/设置/公告 三个入口 Tab（右上角关闭钮）。
 *
 * 「设置」页承载常规与模型两组开关；「账户」页仅在应用提供账户能力时出现；
 * 「公告」页未登录时给出提示，登录后由 main 进程侧的会话拉取公告。
 */
export function SettingsPanel({
  bridge,
  ambientFollow,
  opacity,
  stealth,
  stealthSupported,
  onAmbientFollowChange,
  onOpacityChange,
  onStealthChange,
  announcements,
  unreadAnnouncements,
  signedIn,
  onMarkAnnouncementRead,
  onClose,
}: SettingsPanelProps) {
  // 账号状态只在 main 进程成立；渲染层只拿到 {signedIn, plan, capabilities, cloudBaseUrl}。
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");

  const [modelView, setModelView] = useState<ConversationModelSettingsView | null>(null);
  const [source, setSource] = useState<ConversationModelSource>("cloud");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelNotice, setModelNotice] = useState("");

  // Tab 是面板内的入口切换，属于面板自身的展示状态；面板重开时回到「设置」页。
  const [tab, setTab] = useState<SettingsTab>("settings");

  const getAuthStatus = bridge?.getAuthStatus;
  const onAuthStatus = bridge?.onAuthStatus;
  const getConversationConfig = bridge?.getConversationConfig;
  const getConversationApiKey = bridge?.getConversationApiKey;

  useEffect(() => {
    if (!getAuthStatus) return;
    let cancelled = false;
    getAuthStatus()
      .then((status) => {
        if (!cancelled) setAuthStatus(status);
      })
      .catch(() => undefined);
    // 登录结果由主进程推送（浏览器授权是异步的，登录调用本身不等待结果）。
    const unsubscribe = onAuthStatus?.((status) => {
      setAuthStatus(status);
      if (status.signedIn) setAuthNotice("");
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [getAuthStatus, onAuthStatus]);

  async function signIn() {
    if (!bridge?.loginAccount) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      const result = await bridge.loginAccount();
      if (!result.opened) {
        setAuthError(result.error ?? "无法打开授权页");
        return;
      }
      setAuthNotice("已在浏览器中打开授权页，完成后会自动同步");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setAuthBusy(false);
    }
  }

  useEffect(() => {
    if (!getConversationConfig) return;
    let cancelled = false;
    Promise.all([
      getConversationConfig(),
      getConversationApiKey?.() ?? Promise.resolve({ apiKey: null }),
    ])
      .then(([view, key]) => {
        if (cancelled) return;
        setModelView(view);
        setSource(view.source);
        setBaseUrl(view.baseUrl);
        setModel(view.model);
        setApiKey(key.apiKey ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getConversationConfig, getConversationApiKey]);

  async function signOut() {
    if (!bridge?.logoutAccount) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      setAuthStatus(await bridge.logoutAccount());
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "退出登录失败");
    } finally {
      setAuthBusy(false);
    }
  }

  async function saveModelSettings() {
    if (!bridge?.configureConversation) return;
    setModelBusy(true);
    setModelError("");
    setModelNotice("");
    try {
      const view = await bridge.configureConversation({
        source,
        baseUrl,
        model,
        apiKey: apiKey || undefined,
      });
      setModelView(view);
      setModelNotice("已保存");
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setModelBusy(false);
    }
  }

  async function clearModelSettings() {
    if (!bridge?.clearConversationConfig) return;
    setModelBusy(true);
    setModelError("");
    setModelNotice("");
    try {
      const view = await bridge.clearConversationConfig();
      setModelView(view);
      setSource(view.source);
      setBaseUrl(view.baseUrl);
      setModel(view.model);
      setApiKey("");
      setRevealKey(false);
      setModelNotice("已清除本地配置");
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "清除失败");
    } finally {
      setModelBusy(false);
    }
  }

  // Tab 面：账户入口只在应用提供账户能力时出现（与原账户分组的能力闸门一致）。
  const tabs: PanelTab[] = [
    ...(getAuthStatus ? [{ id: "account", label: "账户" } satisfies PanelTab] : []),
    { id: "settings", label: "设置" },
    { id: "announcements", label: "公告", badge: unreadAnnouncements },
  ];

  const identity = accountIdentity(authStatus);
  const quota = authStatus?.quota ?? null;
  const quotaPercent = quota?.usedPercent ?? null;
  const quotaDays = quota?.daysRemaining ?? null;
  const hasQuota = quotaPercent !== null || quotaDays !== null;

  return (
    <PanelShell
      activeTab={tab}
      onClose={onClose}
      onTabChange={(id) => setTab(id as SettingsTab)}
      tabs={tabs}
      title={TAB_TITLES[tab]}
      variant="settings"
    >
      {tab === "account" && getAuthStatus && (
        <div className="settings-panel">
          <section className="settings-group">
            <div className="setting-row">
              <span>
                <strong>{accountTitle(authStatus)}</strong>
              </span>
              {authStatus?.signedIn ? (
                <SurfaceButton
                  className="setting-action"
                  disabled={authBusy}
                  onClick={() => void signOut()}
                  title="退出登录"
                  variant="quiet"
                >
                  退出登录
                </SurfaceButton>
              ) : (
                <SurfaceButton
                  className="setting-action"
                  disabled={authBusy}
                  onClick={() => void signIn()}
                  title="登录"
                  variant="primary"
                >
                  登录
                </SurfaceButton>
              )}
            </div>
            {identity && <p className="setting-account-identity">{identity}</p>}
            {/* 额度只看服务端进度数据：`capabilities` 是接口面，不代表权益，不参与渲染。 */}
            {authStatus?.signedIn && (
              <div className="setting-quota">
                <span className="setting-quota-head">
                  <span>本月额度</span>
                  <span className="setting-quota-value">
                    {!hasQuota
                      ? "未开通套餐"
                      : `${quotaPercent !== null ? `已用 ${Math.round(quotaPercent)}%` : "套餐有效"}${
                          quotaDays !== null ? ` · 剩余 ${quotaDays} 天` : ""
                        }`}
                  </span>
                </span>
                {quotaPercent !== null && (
                  <span
                    aria-label="本月额度用量"
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={Math.round(quotaPercent)}
                    className="setting-quota-track"
                    role="progressbar"
                  >
                    <span className="setting-quota-fill" style={{ width: `${quotaPercent}%` }} />
                  </span>
                )}
              </div>
            )}
            {authNotice && (
              <p className="setting-status" role="status">
                {authNotice}
              </p>
            )}
            {authError && (
              <p className="setting-error" role="alert">
                {authError}
              </p>
            )}
          </section>
        </div>
      )}

      {tab === "settings" && (
        <div className="settings-panel">
          <section className="settings-group">
            <h2>常规</h2>
            <div className="setting-row">
              <span>
                <strong>跟随背景色</strong>
              </span>
              <Switch
                ariaLabel="跟随背景色"
                checked={ambientFollow}
                onChange={onAmbientFollowChange}
              />
            </div>
            <div className="setting-row">
              <span>
                <strong>前景透明度</strong>
              </span>
              <span className="setting-control">
                <RangeSlider
                  ariaLabel="前景透明度"
                  max={OPACITY_MAX}
                  min={OPACITY_MIN}
                  onChange={onOpacityChange}
                  step={0.05}
                  value={opacity}
                />
                <span className="setting-value">{Math.round(opacity * 100)}%</span>
              </span>
            </div>
            <div className="setting-row">
              <span>
                <strong>会议隐身</strong>
              </span>
              <Switch
                ariaLabel="会议隐身"
                checked={stealth}
                disabled={!stealthSupported && !stealth}
                onChange={onStealthChange}
              />
            </div>
          </section>

          {/* 打包版 localAvailable=false：本地来源不可用，整块「模型」分组不渲染，避免留下空壳分组。 */}
          {modelView?.localAvailable && (
            <section className="settings-group">
              <h2>模型</h2>
              <div className="setting-row">
                <span>
                  <strong>模型来源</strong>
                </span>
                <span className="setting-source-switch">
                  <SurfaceButton
                    aria-pressed={source === "local"}
                    className="setting-source-option"
                    onClick={() => setSource("local")}
                    title="使用本机保存的 OpenAI 兼容端点，不需要登录"
                  >
                    本地模型
                  </SurfaceButton>
                  <SurfaceButton
                    aria-pressed={source === "cloud"}
                    className="setting-source-option"
                    onClick={() => setSource("cloud")}
                    title="使用云端订阅，需要登录"
                  >
                    云端订阅
                  </SurfaceButton>
                </span>
              </div>
              {source === "local" && (
                <>
                  <label className="setting-field">
                    <span>OpenAI 兼容地址</span>
                    <input
                      autoComplete="off"
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="http://127.0.0.1:1234/v1"
                      spellCheck={false}
                      value={baseUrl}
                    />
                  </label>
                  <label className="setting-field">
                    <span>模型 ID</span>
                    <input
                      autoComplete="off"
                      onChange={(event) => setModel(event.target.value)}
                      placeholder="必填"
                      spellCheck={false}
                      value={model}
                    />
                  </label>
                  <label className="setting-field">
                    <span>API Key（可选）</span>
                    <span className="setting-secret-field">
                      <input
                        autoComplete="off"
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder="留空沿用已保存的 Key"
                        spellCheck={false}
                        type={revealKey ? "text" : "password"}
                        value={apiKey}
                      />
                      <SurfaceButton
                        aria-pressed={revealKey}
                        className="setting-secret-toggle"
                        onClick={() => setRevealKey((value) => !value)}
                        title={revealKey ? "隐藏" : "显示"}
                        variant="quiet"
                      >
                        {revealKey ? <EyeOff /> : <Eye />}
                      </SurfaceButton>
                    </span>
                  </label>
                  <div className="setting-model-footer">
                    <span
                      className={
                        modelNotice ? "setting-status setting-status--saved" : "setting-status"
                      }
                    >
                      {modelNotice === "已保存"
                        ? "已保存"
                        : modelView.configured
                          ? "已配置"
                          : "尚未配置"}
                    </span>
                    <span className="setting-model-actions">
                      <SurfaceButton
                        className="setting-action"
                        disabled={modelBusy}
                        onClick={() => void saveModelSettings()}
                        variant="primary"
                      >
                        保存
                      </SurfaceButton>
                      {modelView.configured && (
                        <SurfaceButton
                          className="setting-action"
                          disabled={modelBusy}
                          onClick={() => void clearModelSettings()}
                          variant="quiet"
                        >
                          清除
                        </SurfaceButton>
                      )}
                    </span>
                  </div>
                  <p className="setting-status">本地模式不需要登录，密钥只保存在本机。</p>
                </>
              )}
              {modelError && (
                <p className="setting-error" role="alert">
                  {modelError}
                </p>
              )}
              {modelNotice && modelNotice !== "已保存" && (
                <p className="setting-status" role="status">
                  {modelNotice}
                </p>
              )}
            </section>
          )}
        </div>
      )}

      {tab === "announcements" &&
        (signedIn ? (
          <AnnouncementList announcements={announcements} onMarkRead={onMarkAnnouncementRead} />
        ) : (
          <div className="announcement-list">
            <p className="announcement-empty">登录账户后可查看公告。</p>
          </div>
        ))}
    </PanelShell>
  );
}
