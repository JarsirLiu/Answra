import type {
  AuthStatus,
  ConversationModelSettingsView,
  ConversationModelSource,
  DesktopBridge,
} from "@answra/shared";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { RangeSlider } from "../controls/RangeSlider";
import { SurfaceButton } from "../controls/SurfaceButton";
import { Switch } from "../controls/Switch";
import { PanelShell } from "./PanelShell";
import "./SettingsPanel.css";

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

/**
 * 已登录时的账号摘要。
 *
 * 刻意不引用 `capabilities`：它是「服务端已实现的接口面」，不代表账号额度——把它渲染成
 * 「已解锁 N 项云能力」会把目录误当权益，而实际能否调用由服务端每次请求的额度校验决定。
 */
function accountHint(status: AuthStatus | null): string {
  if (!status?.signedIn) return "";
  return "模型调用由服务端额度控制，未开通时会提示原因";
}

/** 设置面板：账户/模型/常规三组；控件一律用统一令牌控件，不用原生样式。
 *
 * 「模型」分组是显式二选一：本地自定义端点（开发态可用，免登录）或云端订阅（需登录）。
 * 打包版不出现本地来源，固定云端。
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

  const hint = accountHint(authStatus);

  return (
    <PanelShell onClose={onClose} title="设置" variant="settings">
      <div className="settings-panel">
        {bridge?.getAuthStatus && (
          <section className="settings-group">
            <h2>账户</h2>
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
            {hint && <p className="setting-status">{hint}</p>}
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
        )}

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
            {source === "local" ? (
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
            ) : (
              <p className="setting-status">云端订阅：登录后按服务端额度调用</p>
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
      </div>
    </PanelShell>
  );
}
