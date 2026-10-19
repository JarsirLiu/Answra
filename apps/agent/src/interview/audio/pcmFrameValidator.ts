import {
  type AudioSource,
  type InterviewSession,
  isCurrentListeningSession,
  PCM_FRAME_MAX_BYTES,
  type PcmFrame,
  sessionId,
} from "../contracts";

export type PcmFrameRejectionCode =
  | "not-listening"
  | "stale-session"
  | "invalid-frame"
  | "out-of-order"
  | "overlapping-audio";

export interface PcmFrameGap {
  source: AudioSource;
  expectedSequence: number;
  receivedSequence: number;
  expectedStartSample: number;
  receivedStartSample: number;
}

export type PcmFrameValidation =
  | { accepted: true; frame: PcmFrame; gap?: PcmFrameGap }
  | { accepted: false; code: PcmFrameRejectionCode };

interface Cursor {
  nextSequence: number;
  nextSample: number;
}

/** Validates untrusted worker input and tracks continuity independently per source. */
export class PcmFrameValidator {
  private readonly cursors = new Map<AudioSource, Cursor>();

  constructor(private readonly sessionId: PcmFrame["sessionId"]) {}

  accept(input: unknown, session: InterviewSession): PcmFrameValidation {
    if (!isCurrentListeningSession(session, this.sessionId)) {
      return { accepted: false, code: "not-listening" };
    }

    const parsed = parsePcmFrame(input);
    if (!parsed) return { accepted: false, code: "invalid-frame" };
    if (parsed.sessionId !== this.sessionId || session.sessionId !== this.sessionId) {
      return { accepted: false, code: "stale-session" };
    }

    const cursor = this.cursors.get(parsed.source) ?? { nextSequence: 0, nextSample: 0 };
    if (parsed.sequence < cursor.nextSequence) {
      return { accepted: false, code: "out-of-order" };
    }
    if (parsed.startSample < cursor.nextSample) {
      return { accepted: false, code: "overlapping-audio" };
    }

    const gap =
      parsed.sequence > cursor.nextSequence || parsed.startSample > cursor.nextSample
        ? {
            source: parsed.source,
            expectedSequence: cursor.nextSequence,
            receivedSequence: parsed.sequence,
            expectedStartSample: cursor.nextSample,
            receivedStartSample: parsed.startSample,
          }
        : undefined;

    this.cursors.set(parsed.source, {
      nextSequence: parsed.sequence + 1,
      nextSample: parsed.startSample + parsed.pcm.byteLength / 2,
    });

    return { accepted: true, frame: parsed, ...(gap ? { gap } : {}) };
  }
}

function parsePcmFrame(input: unknown): PcmFrame | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = input as Record<string, unknown>;
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.trim().length === 0 ||
    (value.source !== "interviewer" && value.source !== "candidate") ||
    !isNonNegativeSafeInteger(value.sequence) ||
    !isNonNegativeSafeInteger(value.startSample) ||
    value.sampleRate !== 16_000 ||
    value.channels !== 1 ||
    value.encoding !== "pcm_s16le" ||
    !(value.pcm instanceof Uint8Array) ||
    value.pcm.byteLength === 0 ||
    value.pcm.byteLength > PCM_FRAME_MAX_BYTES ||
    value.pcm.byteLength % 2 !== 0
  ) {
    return undefined;
  }

  const sampleCount = value.pcm.byteLength / 2;
  if (value.startSample + sampleCount > Number.MAX_SAFE_INTEGER) return undefined;

  return {
    sessionId: sessionId(value.sessionId),
    source: value.source,
    sequence: value.sequence,
    startSample: value.startSample,
    sampleRate: value.sampleRate,
    channels: value.channels,
    encoding: value.encoding,
    pcm: new Uint8Array(value.pcm),
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
