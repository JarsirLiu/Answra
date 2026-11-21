/** 移动端视图状态；连接状态、run 状态和 transcript 投影不在这里复制。 */
export interface AppViewState {
  readonly activeHostKeyId: string | null;
  readonly activeConversationId: string | null;
  readonly draft: string;
}

export const INITIAL_APP_VIEW_STATE: AppViewState = {
  activeHostKeyId: null,
  activeConversationId: null,
  draft: "",
};
