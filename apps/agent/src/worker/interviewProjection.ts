import type { InterviewDomainEvent } from "../interview/contracts";
import type { InterviewWorkerEvent } from "./protocol";

/** Converts branded Agent events into the serializable worker line protocol. */
export function toInterviewWorkerEvent(event: InterviewDomainEvent): InterviewWorkerEvent {
  switch (event.type) {
    case "session-started":
    case "session-stopped":
      return { ...event };
    case "session-state-changed":
    case "session-failed":
      return { ...event };
    case "transcript-event":
      return { type: "transcript-event", event: { ...event.event } };
    case "turn-started":
      return { ...event };
    case "turn-updated":
      return { type: event.type, turn: { ...event.turn, chunks: [...event.turn.chunks] } };
    case "turn-committed":
      return { type: event.type, turn: { ...event.turn, chunks: [...event.turn.chunks] } };
    case "turn-incomplete":
      return { type: event.type, turn: { ...event.turn, chunks: [...event.turn.chunks] } };
    case "audio-gap":
      return { ...event };
    case "reply-invalidated":
      return { ...event };
  }
}
