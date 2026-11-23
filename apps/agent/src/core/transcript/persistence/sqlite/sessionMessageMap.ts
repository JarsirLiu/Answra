/** Session 行与内存 mutation 之间的纯映射；不执行 SQL。 */
import type { ConversationMessage } from "@answra/shared";
import type { ConversationSessionRecord } from "../../memoryStore";
import type { ConversationStoreMutation } from "../../store";
import {
  mergeDraftMessage,
  restoreStoredSession,
  type StoredSessionState,
  splitSessionRecord,
  summarizeSessionState,
} from "../sessionRecord";
import type { SessionRowInput, StoredSessionRow } from "./sessionRows";

export function buildSessionRowWrite(record: ConversationSessionRecord): {
  input: SessionRowInput;
  messages: readonly ConversationMessage[];
} {
  const { state, messages } = splitSessionRecord(record);
  const metadata = record.metadata;
  if (!metadata) throw new Error("会话缺少 metadata，拒绝持久化");
  const summary = summarizeSessionState(messages, metadata.title);
  return {
    input: {
      state,
      scope: metadata.scope,
      ...(metadata.workspaceRoot === undefined ? {} : { workspaceRoot: metadata.workspaceRoot }),
      title: summary.title,
      messageCount: summary.messageCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    messages,
  };
}

export function buildStoredSessionRecord(
  stored: StoredSessionRow,
  messages: readonly ConversationMessage[],
): ConversationSessionRecord {
  const input: StoredSessionState = {
    state: stored.state,
    messages,
    metadata: {
      scope: stored.scope,
      ...(stored.workspaceRoot === undefined ? {} : { workspaceRoot: stored.workspaceRoot }),
      title: stored.title,
    },
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
  return restoreStoredSession(input);
}

export function mergeStoredSession(stored: StoredSessionRow): {
  record: ConversationSessionRecord;
  draftMessageIds: ReadonlySet<string>;
} {
  const drafts = new Map(
    stored.drafts
      .filter((draft) => draft.baseRevision === stored.revision)
      .map((draft) => [draft.messageId, draft.draft]),
  );
  const messages = stored.messages.map((row) => {
    const draft = drafts.get(row.message.id);
    return draft === undefined ? row.message : mergeDraftMessage(row.message, draft);
  });
  return {
    record: buildStoredSessionRecord(stored, messages),
    draftMessageIds: new Set(drafts.keys()),
  };
}

/**
 * 本次 mutation 需要写入的消息，以及上次失败后仍未落库的消息。
 * 只有会话级 mutation 会补写；草稿与事件不触发正文事务。
 */
export function dirtyMessages(
  messages: readonly ConversationMessage[],
  mutation: ConversationStoreMutation,
  persistedMessageIds: ReadonlySet<string>,
): ConversationMessage[] {
  if (mutation.kind === "stream-checkpoint") return [];
  if (mutation.kind === "cleared") return [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const ids = new Set<string>();
  for (const id of mutation.dirtyMessageIds ?? []) {
    if (!byId.has(id)) throw new Error(`待写入消息不存在：${id}`);
    ids.add(id);
  }
  for (const message of messages) {
    if (!persistedMessageIds.has(message.id)) ids.add(message.id);
  }
  return messages.filter((message) => ids.has(message.id));
}
