/**
 * 仅供 `20261123120000_session_items` 回填使用；该迁移发布后本文件即冻结，不得复用或修改。
 *
 * 只解析迁移期的旧 `message_json` 形状，不复用运行时 schema：
 * 运行时 schema 会继续演进，旧库迁移结果不能随之改变。
 */

export type LegacyMessageStatus = "streaming" | "complete" | "failed" | "interrupted";

export interface LegacyMessage {
  id: string;
  role: "user" | "assistant";
  authorAgentId?: string;
  audience?: { kind: string; agentId?: string };
  text: string;
  images: Array<{ name: string; dataUrl: string }>;
  status: LegacyMessageStatus;
  parts?: LegacyPart[];
  reasoning?: string;
}

export interface LegacyPart {
  id: string;
  kind: string;
  text?: string;
  state?: string;
  toolCallId?: string;
  toolName?: string;
  title?: string;
  input?: unknown;
  inputText?: string;
  output?: unknown;
  errorText?: string;
}

export function parseLegacyMessage(json: string, messageId: string): LegacyMessage {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(
      `消息无法解析，无法迁移条目：${messageId}（${
        error instanceof Error ? error.message : String(error)
      }）`,
    );
  }
  if (typeof value !== "object" || value === null) throw new Error(`消息不是对象：${messageId}`);
  const record = value as Record<string, unknown>;
  const id = requireText(record.id);
  if (id !== messageId) throw new Error(`消息 ID 与行不一致：${messageId} / ${id}`);
  const role = record.role;
  if (role !== "user" && role !== "assistant") {
    throw new Error(`消息角色无效：${messageId}`);
  }
  const status = record.status;
  if (
    status !== "streaming" &&
    status !== "complete" &&
    status !== "failed" &&
    status !== "interrupted"
  ) {
    throw new Error(`消息状态无效：${messageId}`);
  }
  return {
    id,
    role,
    ...(typeof record.authorAgentId === "string" ? { authorAgentId: record.authorAgentId } : {}),
    ...(isAudience(record.audience) ? { audience: record.audience } : {}),
    text: requireText(record.text),
    images: parseImages(record.images, messageId),
    status,
    ...(Array.isArray(record.parts) ? { parts: record.parts.map(parsePart) } : {}),
    ...(typeof record.reasoning === "string" ? { reasoning: record.reasoning } : {}),
  };
}

/**
 * 与 `mergeStoredSession` 同义：草稿正文整体替换已存消息的正文、状态与 parts，
 * 而不是逐字段合并；只有 `base_revision === revision` 的草稿会被调用方传入。
 */
export function mergeLegacyDraft(store: LegacyMessage, draft: LegacyMessage): LegacyMessage {
  if (draft.id !== store.id) throw new Error(`草稿与消息 ID 不一致：${store.id}`);
  if (draft.role !== "assistant") throw new Error(`消息草稿必须是 assistant 消息：${store.id}`);
  const { parts: _parts, reasoning: _reasoning, ...rest } = store;
  return {
    ...rest,
    text: draft.text,
    images: draft.images,
    status: draft.status,
    ...(draft.parts === undefined ? {} : { parts: draft.parts }),
    ...(draft.reasoning === undefined ? {} : { reasoning: draft.reasoning }),
  };
}

function parsePart(value: unknown): LegacyPart {
  if (typeof value !== "object" || value === null) throw new Error("消息 part 不是对象");
  const record = value as Record<string, unknown>;
  return {
    id: requireText(record.id),
    kind: requireText(record.kind),
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(typeof record.state === "string" ? { state: record.state } : {}),
    ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
    ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(record.input === undefined ? {} : { input: record.input }),
    ...(typeof record.inputText === "string" ? { inputText: record.inputText } : {}),
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(typeof record.errorText === "string" ? { errorText: record.errorText } : {}),
  };
}

function parseImages(value: unknown, messageId: string): Array<{ name: string; dataUrl: string }> {
  if (!Array.isArray(value)) throw new Error(`消息 images 无效：${messageId}`);
  return value.map((image) => {
    if (typeof image !== "object" || image === null) {
      throw new Error(`消息 image 无效：${messageId}`);
    }
    const record = image as Record<string, unknown>;
    return { name: requireText(record.name), dataUrl: requireText(record.dataUrl) };
  });
}

function isAudience(value: unknown): value is { kind: string; agentId?: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "user" || record.kind === "bot";
}

function requireText(value: unknown): string {
  if (typeof value !== "string") throw new Error("迁移字段必须是字符串");
  return value;
}
