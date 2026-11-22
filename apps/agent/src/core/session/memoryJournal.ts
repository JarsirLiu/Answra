/** 进程内 SessionJournal 实现；只服务阶段 1 测试与 answer-only 会话。 */
import type { AgentDurableEvent, SessionEventEnvelope } from "@answra/shared/schema";
import type { SessionId } from "./contracts";
import { createSessionEvent } from "./eventFactory";
import type { SessionJournal, SessionJournalAppend } from "./journal";

export class MemorySessionJournal implements SessionJournal {
  private readonly events = new Map<string, SessionEventEnvelope[]>();

  async append(
    sessionId: SessionId,
    event: AgentDurableEvent,
    metadata: SessionJournalAppend = {},
  ): Promise<SessionEventEnvelope> {
    const events = this.events.get(sessionId) ?? [];
    const envelope = createSessionEvent(
      {
        sessionId,
        sequence: events.length + 1,
        ...metadata,
      },
      event,
    );
    events.push(envelope);
    this.events.set(sessionId, events);
    return cloneEnvelope(envelope);
  }

  async readAfter(sessionId: SessionId, sequence: number): Promise<SessionEventEnvelope[]> {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error("Session event sequence 必须是非负整数");
    }
    return (this.events.get(sessionId) ?? [])
      .filter((event) => event.sequence > sequence)
      .map(cloneEnvelope);
  }

  async lastSequence(sessionId: SessionId): Promise<number> {
    return this.events.get(sessionId)?.at(-1)?.sequence ?? 0;
  }

  async clear(sessionId: SessionId): Promise<void> {
    this.events.delete(sessionId);
  }
}

function cloneEnvelope(envelope: SessionEventEnvelope): SessionEventEnvelope {
  return structuredClone(envelope);
}
