import { afterEach, describe, expect, it } from "vitest";
import { TEN_VAD_HOP_SAMPLES } from "../../../src/interview/vad/config";
import { createTenVadEngine, type TenVadHop } from "../../../src/interview/vad/tenVadEngine";

/**
 * tenVadEngine 的合成边界测试：真实 WASM/资源加载与端到端崩溃回归由 desktop 的
 * bundle 探针覆盖；这里用 data: URL 导入的假 glue，从「原生侧视角」观察引擎的
 * 内存契约（glue 注入选项、句柄生命周期、样本窗口传输、输出读回）。
 */

const GLUE_HOOK_KEY = "__vadTestEngineHook__";

/** 假 glue：把 emscripten 注入选项交回测试钩子，返回测试构造的假绑定。 */
const FAKE_GLUE_SOURCE = `export default function createFakeModule(options) {
  const hook = globalThis[${JSON.stringify(GLUE_HOOK_KEY)}];
  if (typeof hook !== "function") throw new Error("fake glue 缺少测试钩子");
  return hook(options);
};`;

const TEST_WASM_BYTES = new Uint8Array([0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** emscripten glue 工厂收到的注入选项；契约与 src/interview/vad/tenVadEngine.ts 对齐。 */
interface FakeFactoryOptions {
  wasmBinary: Uint8Array;
  noInitialRun: boolean;
  noExitRuntime: boolean;
  locateFile(path: string): string;
}

interface FakeVadModule {
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _ten_vad_create(handlePtr: number, hopSize: number, threshold: number): number;
  _ten_vad_process(
    handle: number,
    audioPtr: number,
    audioDataLength: number,
    outProbabilityPtr: number,
    outFlagPtr: number,
  ): number;
  _ten_vad_destroy(handlePtr: number): number;
}

interface FakeVadModuleObserver {
  allocatedPtrs: number[];
  freedPtrs: number[];
  creates: { hopSize: number; threshold: number }[];
  processes: { handle: number; samples: Int16Array }[];
  destroyedHandles: number[];
  factoryOptions?: FakeFactoryOptions;
}

function createFakeVadModule(
  behavior: { createCode?: number; processFlag?: number; processProbability?: number } = {},
): FakeVadModule & FakeVadModuleObserver {
  const raw = new ArrayBuffer(65_536);
  const heap16 = new Int16Array(raw);
  const heap32 = new Int32Array(raw);
  const heapF32 = new Float32Array(raw);
  const observer: FakeVadModuleObserver = {
    allocatedPtrs: [],
    freedPtrs: [],
    creates: [],
    processes: [],
    destroyedHandles: [],
  };
  /** emscripten 约定 ptr 0 为 null，分配从对齐的非零地址开始。 */
  let bump = 4;
  let nextHandle = 0;
  const binding: FakeVadModule = {
    HEAP16: heap16,
    HEAP32: heap32,
    HEAPF32: heapF32,
    _malloc(size) {
      const ptr = bump;
      bump += size;
      observer.allocatedPtrs.push(ptr);
      return ptr;
    },
    _free(ptr) {
      observer.freedPtrs.push(ptr);
    },
    _ten_vad_create(handlePtr, hopSize, threshold) {
      observer.creates.push({ hopSize, threshold });
      if (behavior.createCode) return behavior.createCode;
      nextHandle += 1;
      heap32[handlePtr >> 2] = nextHandle;
      return 0;
    },
    _ten_vad_process(handle, audioPtr, audioDataLength, probPtr, flagPtr) {
      observer.processes.push({
        handle,
        samples: heap16.slice(audioPtr >> 1, (audioPtr >> 1) + audioDataLength),
      });
      heapF32[probPtr >> 2] = behavior.processProbability ?? 0.86;
      heap32[flagPtr >> 2] = behavior.processFlag ?? 1;
      return 0;
    },
    _ten_vad_destroy(handlePtr) {
      const handle = heap32[handlePtr >> 2];
      observer.destroyedHandles.push(handle ?? 0);
      return 0;
    },
  };
  return Object.assign(binding, observer);
}

async function createEngineWithFakeGlue(module: FakeVadModule & FakeVadModuleObserver) {
  const hook = (options: FakeFactoryOptions) => {
    module.factoryOptions = options;
    return module;
  };
  (globalThis as Record<string, unknown>)[GLUE_HOOK_KEY] = hook;
  return createTenVadEngine({ glueSource: FAKE_GLUE_SOURCE, wasmBinary: TEST_WASM_BYTES });
}

describe("ten VAD engine against a synthetic glue module", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[GLUE_HOOK_KEY];
  });

  it("injects the wasm bytes and locateFile instead of letting glue resolve import.meta.url", async () => {
    const module = createFakeVadModule();
    await createEngineWithFakeGlue(module);

    expect(module.factoryOptions?.wasmBinary).toEqual(TEST_WASM_BYTES);
    expect(module.factoryOptions?.noInitialRun).toBe(true);
    expect(module.factoryOptions?.noExitRuntime).toBe(true);
    expect(module.factoryOptions?.locateFile("ten_vad.wasm")).toBe("ten_vad.wasm");
  });

  it("forwards the hop size and threshold into the native create call", async () => {
    const module = createFakeVadModule();
    const engine = await createEngineWithFakeGlue(module);

    engine.createHop(0.5);

    expect(module.creates).toEqual([{ hopSize: TEN_VAD_HOP_SAMPLES, threshold: 0.5 }]);
  });

  it("fails closed and releases every allocation when the native create returns nonzero", async () => {
    const module = createFakeVadModule({ createCode: -7 });
    const engine = await createEngineWithFakeGlue(module);

    expect(() => engine.createHop(0.5)).toThrowError("TEN VAD 检测句柄创建失败（code=-7）");
    expect(module.freedPtrs).toEqual(module.allocatedPtrs);
  });

  it("copies the caller hop window into the wasm heap before inference", async () => {
    const module = createFakeVadModule();
    const engine = await createEngineWithFakeGlue(module);
    const hop = engine.createHop(0.5);
    const window = new Int16Array(TEN_VAD_HOP_SAMPLES);
    for (let sample = 0; sample < window.length; sample += 1)
      window[sample] = ((sample % 7) - 3) * 251;

    hop.processHop(window);

    expect(module.processes).toHaveLength(1);
    expect(module.processes[0]?.samples).toEqual(window);
  });

  it("reads the probability and speech flag back from the wasm heap", async () => {
    const module = createFakeVadModule({ processFlag: 0, processProbability: 0.5 });
    const engine = await createEngineWithFakeGlue(module);
    const hop = engine.createHop(0.5);

    expect(hop.processHop(new Int16Array(TEN_VAD_HOP_SAMPLES))).toEqual({
      probability: 0.5,
      voiced: false,
    });
  });

  it("rejects a hop window whose byte length does not match hopSamples", async () => {
    const module = createFakeVadModule();
    const engine = await createEngineWithFakeGlue(module);
    const hop = engine.createHop(0.5);

    expect(() => hop.processHop(new Int16Array(TEN_VAD_HOP_SAMPLES - 1))).toThrowError(
      "TEN VAD 检测窗长度必须等于 hopSamples×2 字节",
    );
    expect(module.processes).toHaveLength(0);
  });

  it("destroys a known hop exactly once and rejects unknown handles", async () => {
    const module = createFakeVadModule();
    const engine = await createEngineWithFakeGlue(module);
    const hop = engine.createHop(0.5);
    const bogusHop = {
      hopSamples: TEN_VAD_HOP_SAMPLES,
      processHop: () => ({ probability: 0, voiced: false }),
    } as TenVadHop;

    expect(() => engine.destroyHop(bogusHop)).toThrowError("destroyHop 收到未知的检测句柄");
    expect(module.destroyedHandles).toHaveLength(0);

    engine.destroyHop(hop);
    expect(module.destroyedHandles).toEqual([1]);
    expect(module.freedPtrs).toEqual(module.allocatedPtrs);

    expect(() => engine.destroyHop(hop)).toThrowError("destroyHop 收到未知的检测句柄");
    expect(module.destroyedHandles).toHaveLength(1);
  });
});
