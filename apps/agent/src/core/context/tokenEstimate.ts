/** 上下文预算的保守 token 估算；不调用模型，也不依赖 provider 分词器。 */
import type { ConversationMessage } from "@answra/shared";

const ASCII_CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1_024;

/** 估算一段文本的 token 数；CJK 字符按 1 token、其余按 4 字符/token 保守折算。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  for (const char of text) {
    if (isCjk(char.codePointAt(0) ?? 0)) cjkCount += 1;
  }
  return cjkCount + Math.ceil((text.length - cjkCount) / ASCII_CHARS_PER_TOKEN);
}

/** 估算单条 transcript 消息进入模型后的 token 数。 */
export function estimateMessageTokens(message: ConversationMessage): number {
  let tokens = estimateTextTokens(message.text) + message.images.length * IMAGE_TOKEN_ESTIMATE;
  for (const part of message.parts ?? []) {
    if (part.kind === "tool") {
      tokens += estimateTextTokens(part.toolName);
      tokens += estimateTextTokens(part.inputText ?? "");
      tokens += estimateTextTokens(part.errorText ?? "");
      tokens += estimateTextTokens(stringifyValue(part.input));
      tokens += estimateTextTokens(stringifyValue(part.output));
      continue;
    }
    tokens += estimateTextTokens(part.text);
  }
  return tokens;
}

export function estimateMessagesTokens(messages: readonly ConversationMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
