/** 移动端账号授权端口；实现由 apps/mobile/src/auth 提供，UI 与连接核心只依赖此接口。 */
export interface AuthSessionStatus {
  readonly signedIn: boolean;
  readonly account: string | null;
}

export interface AuthPort {
  status(): Promise<AuthSessionStatus>;
  login(): Promise<void>;
  logout(): Promise<void>;
  getAccessToken(): Promise<string>;
}
