import { describe, expect, it } from "vitest";
import type { SpeechActivityEvent } from "../../../src/interview/contracts";
import { SpeechActivityDetector } from "../../../src/interview/vad/speechDetector";
import { hopProgram, makeFrame, scriptedHop, TEST_FRAME_SAMPLES, TEST_SESSION } from "./fixtures";

const SOURCE = "interviewer" as const;

function detectorFor(program: Parameters<typeof scriptedHop>[0]): SpeechActivityDetector {
  return new SpeechActivityDetector(scriptedHop(program), TEST_SESSION, SOURCE);
}

function runFrames(detector: SpeechActivityDetector, frameCount: number): SpeechActivityEvent[] {
  const events: SpeechActivityEvent[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    events.push(...detector.process(makeFrame(SOURCE, index, TEST_FRAME_SAMPLES)));
  }
  return events;
}

describe("speech activity detector", () => {
  it("produces no utterance when voiced blips never reach 250ms of speech", () => {
    // 两段短噪声 blip，随后静音耗尽闭合判决窗：onset 被丢弃，状态回到 idle。
    const detector = detectorFor(
      hopProgram(102, [
        { fromHop: 0, untilHop: 2 },
        { fromHop: 30, untilHop: 31 },
      ]),
    );
    expect(runFrames(detector, 17)).toEqual([]);
  });

  it("emits speech-started with a backdated onset after 250ms of speech", () => {
    const detector = detectorFor(hopProgram(60, [{ fromHop: 4, untilHop: 20 }]));
    const events = runFrames(detector, 4);
    expect(events).toEqual([
      {
        type: "speech-started",
        sessionId: TEST_SESSION,
        source: SOURCE,
        utteranceId: "interviewer-1",
        atSample: 1_024,
        confidence: 0.99,
      },
    ]);
  });

  it("keeps a short pause inside one utterance and closes after 500ms of silence", () => {
    // 静音 10 hop（160ms）后恢复语音：不得再发 started；ended 回溯到最后语音样本。
    const detector = detectorFor(
      hopProgram(102, [
        { fromHop: 4, untilHop: 20 },
        { fromHop: 30, untilHop: 38 },
      ]),
    );
    const events = runFrames(detector, 17);
    expect(events.map((event) => event.type)).toEqual(["speech-started", "speech-ended"]);
    const [started, ended] = events as [
      Extract<SpeechActivityEvent, { type: "speech-started" }>,
      Extract<SpeechActivityEvent, { type: "speech-ended" }>,
    ];
    expect(started.utteranceId).toBe("interviewer-1");
    expect(started.atSample).toBe(1_024);
    expect(ended.utteranceId).toBe("interviewer-1");
    expect(ended.atSample).toBe(9_728);
    expect(ended.confidence).toBe(0.99);
  });

  it("waits through 496ms of silence and closes after the next 16ms VAD hop", () => {
    const detector = detectorFor(hopProgram(54, [{ fromHop: 0, untilHop: 16 }]));
    const events: SpeechActivityEvent[] = [];
    for (let hop = 0; hop < 47; hop += 1) {
      events.push(...detector.process(makeFrame(SOURCE, hop, 256, () => 0, hop * 256)));
    }
    expect(events.map((event) => event.type)).toEqual(["speech-started"]);
    events.push(...detector.process(makeFrame(SOURCE, 47, 256, () => 0, 47 * 256)));
    expect(events.map((event) => event.type)).toEqual(["speech-started", "speech-ended"]);
  });

  it("starts a fresh utterance after a closed one with a strictly increasing id", () => {
    // 两条独立语句：utteranceId 单调递增，ended 回溯到最后语音、started 回溯到 onset。
    const detector = detectorFor(
      hopProgram(120, [
        { fromHop: 4, untilHop: 20 },
        { fromHop: 68, untilHop: 84 },
      ]),
    );
    const events = runFrames(detector, 14);
    expect(events).toHaveLength(3);
    const [, ended, started] = events as [
      Extract<SpeechActivityEvent, { type: "speech-started" }>,
      Extract<SpeechActivityEvent, { type: "speech-ended" }>,
      Extract<SpeechActivityEvent, { type: "speech-started" }>,
    ];
    expect([ended.utteranceId, started.utteranceId]).toEqual(["interviewer-1", "interviewer-2"]);
    expect(ended.atSample).toBe(5_120);
    expect(started.atSample).toBe(17_408);
  });

  it("reset clears speech state but keeps the utterance counter monotonic", () => {
    const detector = detectorFor(
      hopProgram(200, [
        { fromHop: 0, untilHop: 16 },
        { fromHop: 60, untilHop: 76 },
      ]),
    );
    const before = runFrames(detector, 10);
    expect(
      before.filter((event) => event.type === "speech-started").map((event) => event.utteranceId),
    ).toEqual(["interviewer-1"]);
    detector.reset();
    const after = runFrames(detector, 14);
    expect(
      after.filter((event) => event.type === "speech-started").map((event) => event.utteranceId),
    ).toEqual(["interviewer-2"]);
  });
});
