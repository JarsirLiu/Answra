import type { AuthQuotaInfo, AuthStatus } from "@answra/shared";
import { LogOut, User } from "lucide-react";
import { ICON, ICON_LG } from "../../tokens";
import { Badge, type BadgeVariant } from "../controls/Badge";
import { SurfaceButton } from "../controls/SurfaceButton";
import "./AccountPanel.css";

/** 账户页：资料卡 + 额度卡 + 动作行。只展示服务端下发的账号与额度事实，不做本地推演。 */
export interface AccountPanelProps {
  /** 主进程推送/拉取到的账号快照；null 表示尚未拿到。 */
  status: AuthStatus | null;
  /** 登录或退出进行中：动作按钮禁用。 */
  busy: boolean;
  /** 登录引导提示（如"已在浏览器中打开授权页"）。 */
  notice: string;
  /** 登录/退出失败原因。 */
  error: string;
  onSignIn: () => void;
  onSignOut: () => void;
}

/** 身份行文案：已登录优先展示邮箱/用户名；两者都缺失时回落登录态词，不猜档位。 */
function accountIdentity(status: AuthStatus | null): string {
  if (!status?.signedIn) return "未登录";
  return status.account?.email || status.account?.username || "已登录";
}

/**
 * 档位徽章：唯一来源是服务端额度摘要（`quota.kind` / `quota.planName`）。
 * 订阅=实底会员徽章、免费=描边徽章；拿不到额度数据就不渲染，不猜档位语义。
 */
function planBadge(quota: AuthQuotaInfo | null): { text: string; variant: BadgeVariant } | null {
  if (quota?.kind === "subscription") return { text: quota.planName ?? "会员", variant: "solid" };
  if (quota?.kind === "default") return { text: quota.planName ?? "免费版", variant: "outline" };
  return null;
}

/** 日期按本地日历展示：服务端给的是 RFC3339 时间戳，账户页只关心哪一天。 */
function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

/**
 * 额度明细行：标签在左、数值在右。
 * 只列服务端额度摘要里真实存在的字段，缺失的字段不出行，也不补默认值。
 */
function quotaRows(quota: AuthQuotaInfo): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (quota.kind === "subscription") {
    if (typeof quota.usedCredits === "number" && typeof quota.totalCredits === "number") {
      rows.push({
        label: "本周期已用",
        value: `${Math.floor(quota.usedCredits)} / ${Math.floor(quota.totalCredits)} 积分`,
      });
    }
    if (quota.expiresAt) rows.push({ label: "套餐到期", value: formatDate(quota.expiresAt) });
    return rows;
  }
  if (typeof quota.welfareCredits === "number") {
    rows.push({ label: "福利积分", value: `${Math.floor(quota.welfareCredits)}` });
  }
  if (typeof quota.accountCredits === "number") {
    rows.push({ label: "账户额度", value: `${Math.floor(quota.accountCredits)}` });
  }
  if (quota.welfareExpiresAt) {
    rows.push({ label: "福利到期", value: formatDate(quota.welfareExpiresAt) });
  }
  return rows;
}

/**
 * 账户页：资料卡 + 额度卡 + 动作卡。
 *
 * 分组卡版式：分组标题（「额度」）在卡外，信息行装进圆角卡，发丝线只出现在
 * 卡内行间；可用积分是额度卡主行，退出登录独占一张卡、居中警示色。
 * 面板高度随内容收紧（`content-panel--account`）。
 */
export function AccountPanel({
  status,
  busy,
  notice,
  error,
  onSignIn,
  onSignOut,
}: AccountPanelProps) {
  const signedIn = status?.signedIn === true;
  const quota = status?.quota ?? null;
  const badge = planBadge(quota);
  const availableCredits = quota?.availableCredits ?? null;
  const quotaAmount = availableCredits === null ? null : `${Math.floor(availableCredits)} 积分`;
  const usedPercent = quota?.usedPercent ?? null;
  const daysRemaining = quota?.daysRemaining ?? null;
  const rows = signedIn && quota ? quotaRows(quota) : [];

  return (
    <div className="account-page">
      <section className="account-card account-profile">
        <span aria-hidden="true" className="account-avatar">
          <User size={ICON_LG} />
        </span>
        <span className="account-profile-text">
          <span className="account-identity">{accountIdentity(status)}</span>
          {badge && <Badge variant={badge.variant}>{badge.text}</Badge>}
        </span>
      </section>

      {quotaAmount && (
        <div className="account-section">
          <div className="account-section-head">
            <span className="account-section-title">额度</span>
            {daysRemaining !== null && (
              <span className="account-section-note">剩余 {daysRemaining} 天</span>
            )}
          </div>
          <section className="account-card">
            <div className="account-quota-main">
              <span className="account-quota-label">可用积分</span>
              <span className="account-quota-amount">{quotaAmount}</span>
            </div>
            {usedPercent !== null && (
              <span
                aria-label="本月额度用量"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={Math.round(usedPercent)}
                className="account-quota-track"
                role="progressbar"
              >
                <span className="account-quota-fill" style={{ width: `${usedPercent}%` }} />
              </span>
            )}
            {rows.length > 0 && (
              <dl className="account-quota-rows">
                {rows.map((row) => (
                  <div className="account-quota-row" key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        </div>
      )}

      <div className="account-actions">
        {notice && (
          <p className="account-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="account-error" role="alert">
            {error}
          </p>
        )}
        {signedIn ? (
          <section className="account-card">
            <SurfaceButton
              className="account-signout"
              disabled={busy}
              onClick={onSignOut}
              title="退出登录"
              variant="quiet"
            >
              <LogOut aria-hidden="true" size={ICON} />
              退出登录
            </SurfaceButton>
          </section>
        ) : (
          <SurfaceButton
            className="account-signin"
            disabled={busy}
            onClick={onSignIn}
            title="登录"
            variant="primary"
          >
            登录
          </SurfaceButton>
        )}
      </div>
    </div>
  );
}
