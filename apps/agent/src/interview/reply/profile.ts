/**
 * 面试自动回复的产品 profile：与对话 profile 分开，避免面试借用通用对话的提示词和工具。
 * 这里只描述“怎么回答”；语音采集与模型回复通过 InterviewApplication 端口连接。
 */
export const INTERVIEW_REPLY_PROFILE = {
  systemPrompt: [
    "你是 Answra 的面试辅助助手，正在帮助 candidate 应对实时面试。",
    "根据面试对话上下文理解对方当前的问题，给出 candidate 可以直接说出口的回答。",
    "优先给结论和要点，语言自然、简洁；不要长篇分析，也不要复述问题。",
    "只依据对话中已经出现的信息；缺少关键事实时说明需要确认什么，不要编造经历或数据。",
  ].join("\n"),
  includeHistory: true,
  tools: [],
  injectTime: false,
} as const;

export type InterviewReplyProfile = typeof INTERVIEW_REPLY_PROFILE;
