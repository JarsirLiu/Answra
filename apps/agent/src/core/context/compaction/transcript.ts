/** 把 transcript 渲染成摘要模型可读的正文；思考不进入摘要，工具结果按预算截断。 */
import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";

const TOOL_RESULT_MAX_CHARS = 2_000;
const TOOL_RESULT_HEAD_CHARS = 1_200;
const TOOL_RESULT_TAIL_CHARS = 800;
const TOOL_INPUT_MAX_CHARS = 1_000;
const TOOL_INPUT_HEAD_CHARS = 600;
const TOOL_INPUT_TAIL_CHARS = 400;
const TOOL_SECTION_MAX_CHARS = 40_000;
const TRUNCATED_MARKER = "[已截断]";
const OMITTED_TOOL_RESULTS = "[更早工具结果未进入摘要]";

type ToolPart = Extract<ConversationMessagePart, { kind: "tool" }>;

interface RenderedMessage {
  heading: string;
  body: string[];
  tools: string[];
}

export function renderMessagesForSummary(messages: readonly ConversationMessage[]): string {
  const rendered = messages.map(renderMessage).filter(hasContent);
  capToolSections(rendered);
  return rendered
    .filter(hasContent)
    .map((message) => [message.heading, ...message.body, ...message.tools].join("\n"))
    .join("\n\n");
}

/** 摘要请求超限时丢弃最旧的一轮用户回合；只有一轮时返回 undefined。 */
export function dropOldestSummaryTurn(
  messages: readonly ConversationMessage[],
): ConversationMessage[] | undefined {
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser < 0) return messages.length > 1 ? messages.slice(1) : undefined;
  const nextUser = messages.findIndex(
    (message, index) => index > firstUser && message.role === "user",
  );
  return nextUser < 0 ? undefined : messages.slice(nextUser);
}

function renderMessage(message: ConversationMessage): RenderedMessage {
  const heading =
    message.role === "user"
      ? "### 用户"
      : `### 助手${message.authorAgentId ? `（${message.authorAgentId}）` : ""}`;
  const audiences = message.audience?.kind === "bot" ? `（发给 ${message.audience.agentId}）` : "";
  const body: string[] = [];
  if (message.text) body.push(message.text);
  for (const image of message.images) body.push(renderImage(image));
  const tools = (message.parts ?? [])
    .filter((part): part is ToolPart => part.kind === "tool")
    .map(renderToolPart);
  return { heading: heading + audiences, body, tools };
}

function hasContent(message: RenderedMessage): boolean {
  return message.body.length > 0 || message.tools.length > 0;
}

function renderImage(image: { name: string; dataUrl: string }): string {
  const mediaType = /^data:([^;,]+)[;,]/.exec(image.dataUrl)?.[1];
  return mediaType ? `[图片：${image.name}（${mediaType}）]` : `[图片：${image.name}]`;
}

function renderToolPart(part: ToolPart): string {
  const lines = [`[工具调用 ${part.toolName}]`];
  const input = toolInputText(part);
  if (input)
    lines.push(
      `输入: ${truncateToolText(input, TOOL_INPUT_MAX_CHARS, TOOL_INPUT_HEAD_CHARS, TOOL_INPUT_TAIL_CHARS)}`,
    );
  const result = toolResultText(part);
  if (result)
    lines.push(
      `[工具结果] ${truncateToolText(result, TOOL_RESULT_MAX_CHARS, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS)}`,
    );
  return lines.join("\n");
}

function toolInputText(part: ToolPart): string {
  const input = part.input ?? part.inputText;
  return input === undefined ? "" : stringifyToolValue(input);
}

function toolResultText(part: ToolPart): string {
  switch (part.state) {
    case "completed":
      return part.output === undefined ? "[无输出]" : stringifyToolValue(part.output);
    case "failed":
      return `错误: ${part.errorText ?? "工具执行失败。"}`;
    case "denied":
      return "工具调用被拒绝，没有返回结果。";
    case "interrupted":
      return "工具执行被中断，没有返回结果。";
    default:
      return "工具调用未完成，没有返回结果。";
  }
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncateToolText(
  text: string,
  maxChars: number,
  headChars: number,
  tailChars: number,
): string {
  if (text.length <= maxChars) return text;
  const marker = `\n...${TRUNCATED_MARKER}...\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.min(headChars, budget);
  const tail = Math.min(tailChars, budget - head);
  const tailText = tail > 0 ? text.slice(-tail) : "";
  return `${text.slice(0, head)}${marker}${tailText}`;
}

function capToolSections(rendered: RenderedMessage[]): void {
  let total = rendered.reduce(
    (sum, message) => sum + message.tools.reduce((count, tool) => count + tool.length + 1, 0),
    0,
  );
  let omitted = false;
  for (const message of rendered) {
    while (total > TOOL_SECTION_MAX_CHARS && message.tools.length > 0) {
      const removed = message.tools.shift();
      if (!removed) break;
      total -= removed.length + 1;
      omitted = true;
    }
    if (total <= TOOL_SECTION_MAX_CHARS) break;
  }
  if (!omitted) return;
  const firstWithTools = rendered.find((message) => message.tools.length > 0);
  if (firstWithTools) {
    firstWithTools.tools.unshift(OMITTED_TOOL_RESULTS);
    return;
  }
  rendered.find((message) => message.body.length > 0)?.body.unshift(OMITTED_TOOL_RESULTS);
}
