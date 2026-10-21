import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "../../../src/interview/contracts";
import {
  TEN_VAD_HOP_SAMPLES,
  VAD_STAGING_SEGMENT_LIMIT,
  VAD_WARMUP_PENDING_FRAMES,
} from "../../../src/interview/vad/config";
import { InterviewVadPipeline } from "../../../src/interview/vad/pipeline";
import type {
  HopVerdict,
  TenVadEngine,
  TenVadHop,
  TenVadSource,
} from "../../../src/interview/vad/tenVadEngine";
import {
  hopProgram,
  loudSpeechValue,
  makeFrame,
  makePcmBytes,
  scriptedHop,
  TEST_FRAME_SAMPLES,
  TEST_SESSION,
} from "./fixtures";

interface SessionFailure {
  sessionId: SessionId;
  code: "runtime-failed";
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeEngine {
  engine: TenVadEngine;
  destroyed: TenVadHop[];
}

/** 每个 createHop 依序取下一份判决程序；程序耗尽即抛错（推理失败路径）。 */
function makeEngine(programs: HopVerdict[][]): FakeEngine {
  const destroyed: TenVadHop[] = [];
  const engine: TenVadEngine = {
    hopSamples: TEN_VAD_HOP_SAMPLES,
    createHop: () => {
      const program = programs.shift();
      if (!program) throw new Error("夹具引擎已无可用 hop 程序");
      return scriptedHop(program);
    },
    destroyHop: (hop) => {
      destroyed.push(hop);
    },
  };
  return { engine, destroyed };
}

/** 一个完整 utterance 周期的判决程序：16 voiced（≥250ms）+ 44 静默（≥700ms 闭合）。 */
function oneUtteranceCycle(): HopVerdict[] {
  return hopProgram(60, [{ fromHop: 0, untilHop: 16, probability: 0.9 }]);
}

function makePipeline(options: { engine?: TenVadEngine; load?: () => Promise<TenVadEngine> }): {
  pipeline: InterviewVadPipeline;
  failures: SessionFailure[];
} {
  const failures: SessionFailure[] = [];
  const load =
    options.load ??
    (() => {
      if (!options.engine) throw new Error("夹具缺引擎");
      return Promise.resolve(options.engine);
    });
  const pipeline = new InterviewVadPipeline({
    vad: { load } satisfies TenVadSource,
    failSession: (sessionId, code) => failures.push({ sessionId, code }),
  });
  return { pipeline, failures };
}

describe("interview vad pipeline", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("fails the session explicitly and releases the hop when inference throws", async () => {
    // 判决程序只有 6 项：第二帧的第 7 个 hop 越界抛错，deliver 把它升级为会话级失败。
    const { engine, destroyed } = makeEngine([hopProgram(6)]);
    const { pipeline, failures } = makePipeline({ engine });
    await pipeline.start(TEST_SESSION);

    pipeline.handleFrame(makeFrame("interviewer", 0, TEST_FRAME_SAMPLES, loudSpeechValue));
    pipeline.handleFrame(makeFrame("interviewer", 1, TEST_FRAME_SAMPLES, loudSpeechValue));
    expect(failures).toEqual([{ sessionId: TEST_SESSION, code: "runtime-failed" }]);

    pipeline.handleFrame(makeFrame("interviewer", 2, TEST_FRAME_SAMPLES, loudSpeechValue));
    expect(failures).toHaveLength(1);
    await vi.waitFor(() => expect(destroyed).toHaveLength(1));
  });

  it("caps the pre-engine frame buffer and fails beyond the warmup budget", async () => {
    const gate = deferred<TenVadEngine>();
    const { engine } = makeEngine([hopProgram(6)]);
    const { pipeline, failures } = makePipeline({ load: () => gate.promise });
    const starting = pipeline.start(TEST_SESSION);

    for (let index = 0; index < VAD_WARMUP_PENDING_FRAMES; index += 1) {
      pipeline.handleFrame(makeFrame("interviewer", index, TEST_FRAME_SAMPLES));
    }
    expect(failures).toHaveLength(0);

    pipeline.handleFrame(makeFrame("interviewer", VAD_WARMUP_PENDING_FRAMES, TEST_FRAME_SAMPLES));
    expect(failures).toEqual([{ sessionId: TEST_SESSION, code: "runtime-failed" }]);

    pipeline.handleFrame(makeFrame("interviewer", 17, TEST_FRAME_SAMPLES));
    expect(failures).toHaveLength(1);

    gate.resolve(engine);
    await starting;
  });

  it("replays warmup pending frames in stream order once the engine resolves", async () => {
    const gate = deferred<TenVadEngine>();
    // 66 hops：18 voiced（3 个暖机帧）+ 44 静默 → ended 在 hop 61（第 11 帧内）发出。
    const { engine } = makeEngine([hopProgram(66, [{ fromHop: 0, untilHop: 18 }])]);
    const { pipeline, failures } = makePipeline({ load: () => gate.promise });
    const starting = pipeline.start(TEST_SESSION);

    for (let index = 0; index < 3; index += 1) {
      pipeline.handleFrame(makeFrame("interviewer", index, TEST_FRAME_SAMPLES, loudSpeechValue));
    }
    expect(pipeline.stagedSegments("capture-1")).toHaveLength(0);

    gate.resolve(engine);
    await starting;

    for (let frame = 3; frame < 11; frame += 1) {
      pipeline.handleFrame(makeFrame("interviewer", frame, TEST_FRAME_SAMPLES));
    }

    const staged = pipeline.stagedSegments("capture-1");
    expect(staged).toHaveLength(1);
    const segment = staged[0]!;
    expect(segment).toMatchObject({
      startSample: 0,
      endSample: 18 * TEN_VAD_HOP_SAMPLES,
      source: "interviewer",
    });
    // 段内容必须完整覆盖暖机期三帧的响度语音：顺序错乱或帧丢失都会在此红。
    expect(segment.pcm).toEqual(makePcmBytes(18 * TEN_VAD_HOP_SAMPLES, loudSpeechValue, 0));

    pipeline.dispose();
    expect(failures).toHaveLength(0);
  });

  it("memoizes a single engine load and rethrows failures for later sessions without failing them", async () => {
    const load = vi.fn(() => Promise.reject(new Error("VAD 资源缺失，请运行 vad:prepare")));
    const { pipeline, failures } = makePipeline({ load });

    await expect(pipeline.start(TEST_SESSION)).rejects.toThrowError("VAD 资源缺失");
    await expect(pipeline.start(TEST_SESSION)).rejects.toThrowError("VAD 资源缺失");

    expect(load).toHaveBeenCalledTimes(1);
    // start 抛错即终止（host 负责把失败投影成 session-failed 响应）；管线不再回调。
    expect(failures).toHaveLength(0);
  });

  it("keeps staged segments bounded by dropping the oldest beyond the staging limit", async () => {
    const { engine } = makeEngine([Array.from({ length: 33 }, oneUtteranceCycle).flat()]);
    const { pipeline, failures } = makePipeline({ engine });
    await pipeline.start(TEST_SESSION);

    for (let frame = 0; frame < 330; frame += 1) {
      pipeline.handleFrame(makeFrame("interviewer", frame, TEST_FRAME_SAMPLES, loudSpeechValue));
    }

    const staged = pipeline.stagedSegments("capture-1");
    expect(staged).toHaveLength(VAD_STAGING_SEGMENT_LIMIT);
    expect(String(staged[0]?.utteranceId ?? "")).toBe("interviewer-2");
    expect(String(staged[staged.length - 1]?.utteranceId ?? "")).toBe("interviewer-33");
    expect(failures).toHaveLength(0);
    pipeline.dispose();
  });

  it("routes frames per source so each channel keeps its own utterance timeline", async () => {
    // interviewer 66 hops（18 voiced + 48 静默 → ended）；candidate 全静默无事件。
    const { engine, destroyed } = makeEngine([
      hopProgram(66, [{ fromHop: 0, untilHop: 18 }]),
      hopProgram(66),
    ]);
    const { pipeline, failures } = makePipeline({ engine });
    await pipeline.start(TEST_SESSION);

    for (let frame = 0; frame < 11; frame += 1) {
      pipeline.handleFrame(makeFrame("interviewer", frame, TEST_FRAME_SAMPLES, loudSpeechValue));
      pipeline.handleFrame(makeFrame("candidate", frame, TEST_FRAME_SAMPLES));
    }

    const staged = pipeline.stagedSegments("capture-1");
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ source: "interviewer" });

    pipeline.dispose();
    await vi.waitFor(() => expect(destroyed).toHaveLength(2));
    expect(failures).toHaveLength(0);
  });
});
