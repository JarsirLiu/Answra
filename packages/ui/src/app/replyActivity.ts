import type { ConversationEvent, ReplyBarActivity } from "@answra/shared";

export function projectReplyActivity(
  current: ReplyBarActivity[],
  event: ConversationEvent,
): ReplyBarActivity[] {
  const { stream, runId } = event;
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
  if (stream.type === "text-delta")
    return add({ id: stream.partId, kind: "text", label: "", text: stream.delta }, true);
  if (stream.type === "reasoning-delta")
    return add({ id: stream.partId, kind: "thinking", label: "思考", text: stream.delta }, true);
  if (stream.type === "tool-input-start")
    return add({
      id: `${stream.toolCallId}:start`,
      kind: "tool",
      label: `工具：${stream.title ?? stream.toolName}`,
      text: "准备调用",
    });
  if (stream.type === "tool-input-delta")
    return add(
      {
        id: `${stream.toolCallId}:input`,
        kind: "tool",
        label: "工具参数",
        text: stream.delta,
      },
      true,
    );
  if (stream.type === "tool-call")
    return add({
      id: `${stream.toolCallId}:input-ready`,
      kind: "tool",
      label: `工具：${stream.toolName}`,
      text: formatValue(stream.input),
    });
  if (stream.type === "tool-result")
    return add({
      id: `${stream.toolCallId}:output`,
      kind: "tool",
      label: "工具结果",
      text: formatValue(stream.output),
    });
  if (stream.type === "tool-error")
    return add({
      id: `${stream.toolCallId}:error`,
      kind: "error",
      label: "工具失败",
      text: stream.errorText,
    });
  if (stream.type === "error")
    return add({ id: `${runId}:error`, kind: "error", label: "模型错误", text: stream.errorText });
  if (stream.type === "start")
    return add({ id: `${runId}:start`, kind: "status", label: "模型已连接，等待输出", text: "" });
  if (stream.type === "source-url" || stream.type === "source-document")
    return add({
      id: stream.sourceId,
      kind: "source",
      label: "来源",
      text: stream.type === "source-url" ? (stream.title ?? stream.url) : stream.title,
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
