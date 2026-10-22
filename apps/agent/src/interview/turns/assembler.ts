/**
 * Aggregates one natural VAD utterance and its ordered ASR chunks into a committed turn.
 * It does not merge separate utterances or decide whether an Agent should answer.
 */
import {
  type AudioSegment,
  conversationId as asConversationId,
  turnId as asTurnId,
  type CommittedInterviewTurn,
  type ConversationId,
  type SessionId,
  type TranscriptChunk,
  type TranscriptEvent,
} from "../contracts";

interface PendingTurn {
  sessionId: SessionId;
  conversationId: ConversationId;
  utteranceId: string;
  chunks: Map<number, TranscriptChunk>;
  failed: boolean;
  finalChunkIndex?: number;
}

export class InterviewTurnAssembler {
  private readonly pending = new Map<string, PendingTurn>();

  registerSegment(segment: AudioSegment, conversationId: ConversationId): void {
    if (segment.source !== "candidate") return;
    const key = turnKey(segment.sessionId, segment.utteranceId);
    const turn: PendingTurn = this.pending.get(key) ?? {
      sessionId: segment.sessionId,
      conversationId,
      utteranceId: segment.utteranceId,
      chunks: new Map(),
      failed: false,
    };
    if (segment.boundary === "utterance-end") turn.finalChunkIndex = segment.chunkIndex;
    this.pending.set(key, turn);
  }

  accept(event: TranscriptEvent): CommittedInterviewTurn | undefined {
    if (event.source !== "candidate" || event.kind === "partial") return undefined;
    const key = turnKey(event.sessionId, event.utteranceId);
    const turn = this.pending.get(key);
    if (!turn) return undefined;
    if (event.kind === "error") {
      turn.failed = true;
      this.pending.delete(key);
      return undefined;
    }
    turn.chunks.set(event.chunkIndex, {
      utteranceId: event.utteranceId,
      chunkIndex: event.chunkIndex,
      startSample: event.startSample,
      endSample: event.endSample,
      text: event.text,
    });
    if (event.boundary === "utterance-end") turn.finalChunkIndex = event.chunkIndex;
    if (turn.finalChunkIndex === undefined || turn.failed) return undefined;
    for (let index = 0; index <= turn.finalChunkIndex; index += 1)
      if (!turn.chunks.has(index)) return undefined;
    this.pending.delete(key);
    return {
      sessionId: turn.sessionId,
      conversationId: asConversationId(turn.conversationId),
      turnId: asTurnId(`${turn.sessionId}:${turn.utteranceId}`),
      version: 0,
      status: "committed",
      chunks: [...turn.chunks.values()].sort((left, right) => left.chunkIndex - right.chunkIndex),
      missingChunkIndexes: [],
    };
  }

  abandon(sessionId: SessionId, utteranceId: string): void {
    this.pending.delete(turnKey(sessionId, utteranceId));
  }

  reset(sessionId?: SessionId): void {
    if (!sessionId) {
      this.pending.clear();
      return;
    }
    for (const [key, turn] of this.pending)
      if (turn.sessionId === sessionId) this.pending.delete(key);
  }
}

function turnKey(sessionId: SessionId, utteranceId: string): string {
  return `${sessionId}:${utteranceId}`;
}
