import type { ConversationMessage, ReplyBarActivity } from "@answra/shared";

/**
 * 前端唯一可渲染的 AI 消息模型：对话、面试、回复详情都消费这一份结构。
 * 投影只在这里补渲染态（思维链/活动卡片），不改变持久化消息契约。
 */
export interface ConversationViewMessage {
  id: string;
  role: ConversationMessage["role"];
  text: string;
  status: ConversationMessage["status"];
  /** 由模型流事件投影出的思考状态；不从消息正文或 status 推导。 */
  thinking?: boolean;
  /** Agent 已接受活动 run，但尚未发出具体流活动事件。 */
  waitingForStream?: boolean;
  reasoning?: string;
  images?: ConversationMessage["images"];
  activities?: readonly ReplyBarActivity[];
}

/** 一次模型调用重试的渲染态；同一条消息内原地更新，不新增消息。 */
export interface ConversationRetry {
  kind: "rate-limit" | "server-error" | "network-error";
  attempt: number;
  maxRetries: number;
  /** 来自失败 run 终态；保留 Wi-Fi 记录，但不再表示正在等待。 */
  finished?: boolean;
}
