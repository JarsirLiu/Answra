/**
 * 云端账号频道（登录解锁会员）。
 *
 * main 持有全部 token 与刷新逻辑；渲染层只能拿到不含 token 的 `AuthStatus`。
 */
export const AuthChannels = {
  /** 在系统浏览器打开站点授权页完成登录；回跳由深链/环回回调驱动，本调用不等待结果。 */
  Login: "answra:auth:login",
  /** 退出登录：尽最大努力撤销本机 refresh token 并清除本地凭据。 */
  Logout: "answra:auth:logout",
  /** 查询当前账号与会员状态（不含任何 token）；access token 有效时直接返回缓存。 */
  GetStatus: "answra:auth:get-status",
  /** 强制从云端同步账号与额度快照（账户面板每次打开时调用）。 */
  Sync: "answra:auth:sync",
  /** 主进程推送账号状态变化（登录成功、登出、凭据失效）。 */
  Status: "answra:auth:status",
  /** 读取当前账号可见的站点公告；token 只由 main 使用。 */
  ListAnnouncements: "answra:auth:list-announcements",
  /** 将当前账号可见公告标记为已读。 */
  MarkAnnouncementRead: "answra:auth:mark-announcement-read",
} as const;

export type AnnouncementPlatform = "web" | "desktop";

export interface DesktopAnnouncement {
  id: number;
  title: string;
  content: string;
  platform: AnnouncementPlatform;
  startsAt: string | null;
  endsAt: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 已登录账号的展示信息（不含 token）。
 * 字段均为服务端原样下发的可空值：站点允许用用户名或邮箱登录，缺哪个就为 null。
 */
export interface AuthAccountInfo {
  email: string | null;
  username: string | null;
}

/**
 * 用户可用额度快照（来自站点 `GET /api/v1/user/quota`）。
 * 只包含积分与周期信息，不含余额金额或服务端内部计价。
 */
export interface AuthQuotaInfo {
  /** 服务端解析的权益名称：付费套餐名或免费版。 */
  planName?: string | null;
  /** 额度形态，来自服务端 entitlement。 */
  kind?: "subscription" | "default";
  /** 当前可用积分；订阅模式取最严格周期剩余，免费模式为福利与账户积分之和。 */
  availableCredits?: number | null;
  /** 订阅当前周期的已用积分。 */
  usedCredits?: number | null;
  /** 订阅当前周期的总积分。 */
  totalCredits?: number | null;
  /** 无付费订阅时有效福利积分的剩余量。 */
  welfareCredits?: number | null;
  /** 无付费订阅时账户可用额折算的积分。 */
  accountCredits?: number | null;
  /** 最近一笔有效福利的到期时间。 */
  welfareExpiresAt?: string | null;
  /** 当前计费周期已用额度百分比（0-100）；服务端未提供为 null。 */
  usedPercent: number | null;
  /** 套餐到期时间（RFC3339）；无到期时间或无有效套餐为 null。 */
  expiresAt: string | null;
  /** 套餐剩余天数；无有效套餐为 null。 */
  daysRemaining: number | null;
}

/**
 * 账号与会员状态快照。
 *
 * 故意不含 token：渲染层（以及未来可能的调试面板）只需要门禁与展示所需的事实。
 */
export interface AuthStatus {
  signedIn: boolean;
  /** 会员档位标识，由服务端下发；未登录为 null。 */
  plan: string | null;
  /** 账号展示信息；未登录、旧版本或拉取失败时为 null。 */
  account?: AuthAccountInfo | null;
  /** 套餐额度快照；无有效套餐或未登录时为 null。 */
  quota?: AuthQuotaInfo | null;
  /** 当前账号可用的能力 ID 列表（如 `text.chat`）；未登录为空数组。 */
  capabilities: string[];
  /** 云端模式要使用的网关地址（本地只保存地址，不含模型配置）；未登录为 null。 */
  cloudBaseUrl: string | null;
}

/** 登录启动结果：只表示浏览器是否被拉起，登录结果经 `AuthChannels.Status` 推送。 */
export interface AuthLoginResult {
  opened: boolean;
  error?: string;
}

export interface AuthChannelMap {
  [AuthChannels.Login]: { request: undefined; response: AuthLoginResult };
  [AuthChannels.Logout]: { request: undefined; response: AuthStatus };
  [AuthChannels.GetStatus]: { request: undefined; response: AuthStatus };
  [AuthChannels.Sync]: { request: undefined; response: AuthStatus };
  [AuthChannels.Status]: { request: undefined; response: undefined };
  [AuthChannels.ListAnnouncements]: { request: undefined; response: DesktopAnnouncement[] };
  [AuthChannels.MarkAnnouncementRead]: { request: number; response: undefined };
}
