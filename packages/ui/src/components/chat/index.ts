/**
 * AI 消息可组合部件：每个部件独立成组件，可按需拼装成新的消息流/面板。
 * - AssistantMessage：统一容器，纵向排布思考/正文/自定义部件
 * - ThinkingReasoning：思维链（折叠摘要 + 流式句子）
 * - TextResponse：正文排版
 * - MessageTimeline：思考/正文/工具卡按 part 顺序排布
 * - MessageActions：消息操作条（点赞/复制/引用/更多/时间）
 * - MessageStream：消息流视口（自动跟随 + 定位到最新回复按钮）
 * - useFollowLatest：跟随滚动控制器（供自定义视口复用）
 */
export { AssistantMessage } from "./AssistantMessage";
export {
  AGENT_SERVICE_UNAVAILABLE_NOTICE,
  ConnectionNotice,
  formatConnectionNotice,
} from "./ConnectionNotice";
export { MessageActions } from "./MessageActions";
export { MessageStream, useFollowLatest } from "./MessageStream";
export { MessageTimeline } from "./MessageTimeline";
export { ModelErrorNotice } from "./ModelErrorNotice";
export { RetryNotice } from "./RetryNotice";
export { TextResponse } from "./TextResponse";
export { ThinkingReasoning } from "./ThinkingReasoning";
