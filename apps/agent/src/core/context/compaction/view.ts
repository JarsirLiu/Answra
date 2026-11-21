/** 摘要压缩的唯一输入视图：token 与清理水印必须来自同一次最终请求准备。 */
import type { ConversationMessage } from "@answra/shared";

export interface CompactionView {
  /** 原始 transcript，只用于检查点规划和保留用户消息。 */
  readonly messages: readonly ConversationMessage[];
  /** 清理后的最终模型请求 token，用于触发判断。 */
  readonly finalRequestTokens: number;
  /** 最终模型请求已清理的 toolCallId；摘要渲染必须应用同一集合。 */
  readonly prunedToolCallIds: ReadonlySet<string>;
}
