import type { AuthStatus, DesktopBridge } from "@answra/shared";
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

/** 设置面板：账户/常规两组；控件一律用统一令牌控件，不用原生样式。
 *
 * 没有「模型」分组：模型端点、上游模型与额度全部由服务端决定，客户端不再保存任何模型配置。
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

  const getAuthStatus = bridge?.getAuthStatus;
  const onAuthStatus = bridge?.onAuthStatus;

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
