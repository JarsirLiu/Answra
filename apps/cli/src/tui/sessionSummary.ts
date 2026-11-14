/** TUI 账户状态投影：供 `/status` 面板显示账户标签。 */
export type TuiAccountState =
  | { readonly kind: "signed-in"; readonly account: string }
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" };

export function accountState(input: {
  readonly authAvailable: boolean;
  readonly authSignedIn: boolean;
  readonly authAccount?: string;
}): TuiAccountState {
  if (!input.authAvailable) return { kind: "unavailable" };
  if (!input.authSignedIn) return { kind: "signed-out" };
  return { kind: "signed-in", account: input.authAccount ?? "Answra 账户" };
}

export function accountLabel(account: TuiAccountState): string {
  switch (account.kind) {
    case "signed-in":
      return account.account;
    case "signed-out":
      return "未登录";
    case "unavailable":
      return "不可用";
  }
}
