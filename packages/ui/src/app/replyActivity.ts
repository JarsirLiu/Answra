import type { ConversationEvent, ReplyBarActivity } from "@answra/shared";

export function projectReplyActivity(
  current: ReplyBarActivity[],
  event: ConversationEvent,
): ReplyBarActivity[] {
  const { chunk, runId } = event;
  const add = (activity: ReplyBarActivity, merge = false) => {
    const priorIndex = merge
      ? current.findIndex((item) => item.id === activity.id && item.kind === activity.kind)
      : -1;
    if (priorIndex !== -1) {
      return current.map((item, index) =>
        index === priorIndex ? { ...item, text: item.text + activity.text } : item,
      );
    }
    return [...current, activity];
  };
  if (chunk.type === "text-delta")
    return add({ id: chunk.id, kind: "text", label: "", text: chunk.delta }, true);
  if (chunk.type === "reasoning-delta")
    return add({ id: chunk.id, kind: "thinking", label: "思考", text: chunk.delta }, true);
  if (chunk.type === "tool-input-start")
    return add({
      id: `${chunk.toolCallId}:start`,
      kind: "tool",
      label: `工具：${chunk.title ?? chunk.toolName}`,
      text: "准备调用",
    });
  if (chunk.type === "tool-input-delta")
    return add(
      {
        id: `${chunk.toolCallId}:input`,
        kind: "tool",
        label: "工具参数",
        text: chunk.inputTextDelta,
      },
      true,
    );
  if (chunk.type === "tool-input-available")
    return add({
      id: `${chunk.toolCallId}:input-ready`,
      kind: "tool",
      label: `工具：${chunk.title ?? chunk.toolName}`,
      text: formatValue(chunk.input),
    });
  if (chunk.type === "tool-output-available")
    return add({
      id: `${chunk.toolCallId}:output`,
      kind: "tool",
      label: "工具结果",
      text: formatValue(chunk.output),
    });
  if (chunk.type === "tool-input-error" || chunk.type === "tool-output-error")
    return add({
      id: `${chunk.toolCallId}:error`,
      kind: "error",
      label: "工具失败",
      text: chunk.errorText,
    });
  if (chunk.type === "error")
    return add({ id: `${runId}:error`, kind: "error", label: "模型错误", text: chunk.errorText });
  if (chunk.type === "start")
    return add({ id: `${runId}:start`, kind: "status", label: "模型已连接，等待输出", text: "" });
  if (chunk.type === "source-url" || chunk.type === "source-document")
    return add({
      id: chunk.sourceId,
      kind: "source",
      label: "来源",
      text: chunk.type === "source-url" ? (chunk.title ?? chunk.url) : chunk.title,
    });
  return current;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "工具已返回结果";
  }
}
