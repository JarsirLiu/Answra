import { TEN_VAD_HOP_SAMPLES } from "./config";

/** glue 内引用的 wasm 文件名；仅在 locateFile 分支充当占位路径。 */
const TEN_VAD_WASM_NAME = "ten_vad.wasm";

/**
 * TEN VAD 的 emscripten WASM 运行时边界。
 * 资源（glue 源码 + wasm 字节）以内存注入；本模块不接触磁盘路径。
 * 每个检测句柄按 256 样本（16ms）同步返回 {probability, flag}。
 */

export interface HopVerdict {
  probability: number;
  voiced: boolean;
}

/** 单个 VAD 检测句柄：消费与 hopSamples 等长的 int16 声音窗，同步产出判决。 */
export interface TenVadHop {
  hopSamples: number;
  processHop(samples: Int16Array): HopVerdict;
}

export interface TenVadEngine {
  hopSamples: number;
  createHop(threshold: number): TenVadHop;
  destroyHop(hop: TenVadHop): void;
}

/** desktop 组合根提供的资源来源：agent 不读盘，只消费已载入内存的字节。 */
export interface TenVadSource {
  load(): Promise<TenVadEngine>;
}

interface TenVadModuleBinding {
  _ten_vad_create(handlePtr: number, hopSize: number, threshold: number): number;
  _ten_vad_process(
    handle: number,
    audioDataPtr: number,
    audioDataLength: number,
    outProbabilityPtr: number,
    outFlagPtr: number,
  ): number;
  _ten_vad_destroy(handlePtr: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
}

type TenVadModuleFactory = (options: {
  wasmBinary: Uint8Array;
  noInitialRun: boolean;
  noExitRuntime: boolean;
  locateFile: (path: string) => string;
}) => Promise<TenVadModuleBinding>;

interface NativeHopResources {
  module: TenVadModuleBinding;
  handle: number;
  handlePtr: number;
  audioPtr: number;
  probPtr: number;
  flagPtr: number;
}

/** 每个 hop 的原生资源槽；hop → 资源 由 WeakMap 索引，destroyHop 据此回收。 */
const HOPS_BY_HOP = new WeakMap<TenVadHop, NativeHopResources>();

/** 加载一次 emscripten 胶水（data: URL 动态导入，无文件系统访问）。 */
export async function createTenVadEngine(options: {
  glueSource: string;
  wasmBinary: Uint8Array;
}): Promise<TenVadEngine> {
  const binding = await loadModule(options.glueSource, options.wasmBinary);
  return {
    hopSamples: TEN_VAD_HOP_SAMPLES,
    createHop: (threshold) => createNativeHop(binding, threshold),
    destroyHop(hop) {
      const native = HOPS_BY_HOP.get(hop);
      if (!native) throw new Error("destroyHop 收到未知的检测句柄");
      HOPS_BY_HOP.delete(hop);
      releaseNativeHop(native);
    },
  };
}

async function loadModule(
  glueSource: string,
  wasmBinary: Uint8Array,
): Promise<TenVadModuleBinding> {
  const factoryUrl = `data:text/javascript;base64,${Buffer.from(glueSource, "utf8").toString("base64")}`;
  const imported = (await import(/* @vite-ignore */ factoryUrl)) as {
    default: TenVadModuleFactory;
  };
  return imported.default({
    wasmBinary,
    // 预编译资源由调用方注入字节；emscripten 构建关闭文件系统（NO_FILESYSTEM=1）。
    noInitialRun: true,
    noExitRuntime: true,
    // glue 顶层会按 import.meta.url 相对解析 wasm 路径，而 glue 经 data: URL 导入时
    // import.meta.url 不可作解析 base，会直接抛 Invalid URL。显式给出 locateFile
    // 走 emscripten 的注入分支：wasmBinary 已就位，该路径不会被真实读取。
    locateFile: () => TEN_VAD_WASM_NAME,
  });
}

function createNativeHop(module: TenVadModuleBinding, threshold: number): TenVadHop {
  const handlePtr = module._malloc(4);
  const audioPtr = module._malloc(TEN_VAD_HOP_SAMPLES * 2);
  const probPtr = module._malloc(4);
  const flagPtr = module._malloc(4);
  const created =
    handlePtr > 0 && audioPtr > 0 && probPtr > 0 && flagPtr > 0
      ? module._ten_vad_create(handlePtr, TEN_VAD_HOP_SAMPLES, threshold)
      : -1;
  if (created !== 0) {
    module._free(handlePtr);
    module._free(audioPtr);
    module._free(probPtr);
    module._free(flagPtr);
    throw new Error(`TEN VAD 检测句柄创建失败（code=${created}）`);
  }
  const handle = module.HEAP32[handlePtr >> 2];
  if (handle === undefined) throw new Error("TEN VAD 检测句柄读取失败");
  const native: NativeHopResources = {
    module,
    handle,
    handlePtr,
    audioPtr,
    probPtr,
    flagPtr,
  };
  const hop: TenVadHop = {
    hopSamples: TEN_VAD_HOP_SAMPLES,
    processHop(samples) {
      if (samples.byteLength !== TEN_VAD_HOP_SAMPLES * 2)
        throw new TypeError("TEN VAD 检测窗长度必须等于 hopSamples×2 字节");
      // 上游 _ten_vad_process 的唯一输入通道是 audioPtr 指向的 wasm 缓冲；
      // 不拷贝样本就会拿未初始化内存参与推理（此前任何非静音输入都被判错）。
      module.HEAP16.set(samples, native.audioPtr >> 1);
      const result = module._ten_vad_process(
        native.handle,
        native.audioPtr,
        TEN_VAD_HOP_SAMPLES,
        native.probPtr,
        native.flagPtr,
      );
      if (result !== 0) throw new Error(`TEN VAD 推理失败（code=${result}）`);
      const probability = module.HEAPF32[native.probPtr >> 2];
      if (probability === undefined) throw new Error("TEN VAD 输出概率读取失败");
      return {
        probability,
        voiced: module.HEAP32[native.flagPtr >> 2] === 1,
      };
    },
  };
  HOPS_BY_HOP.set(hop, native);
  return hop;
}

function releaseNativeHop(native: NativeHopResources): void {
  const { module, handlePtr, audioPtr, probPtr, flagPtr } = native;
  module._ten_vad_destroy(handlePtr);
  module._free(handlePtr);
  module._free(audioPtr);
  module._free(probPtr);
  module._free(flagPtr);
}
