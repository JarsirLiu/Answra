/**
 * 本地离线识别引擎端口。agent 只依赖该接口；desktop 组合根把
 * sherpa-onnx 预编译 addon 适配成 OfflineRecognizerModule 注入，
 * 引擎配置差异（模型文件布局、lang 参数等）与 stream 生命周期不出现在领域层。
 */

export interface OfflineRecognizerSession {
  /**
   * 整段单次解码，返回引擎原始文本；空串语义由 adapter 层解释。
   * 解码是同步 native 调用；引擎内部错误原样抛出，由 adapter 归一化。
   */
  transcribeOnce(input: { samples: Float32Array; sampleRate: number }): string;
}

/** 引擎装配参数；路径合法性由注入方（desktop 资源准备）校验后传入。 */
export interface OfflineRecognizerRecipe {
  modelPath: string;
  tokensPath: string;
  numThreads: number;
}

export interface OfflineRecognizerModule {
  /** 加载失败（缺文件/SHA 不符/addon 不可用）直接抛错：composition root fail-closed。 */
  create(recipe: OfflineRecognizerRecipe): OfflineRecognizerSession;
}

/** 装配完成后的引擎件：module + recipe，正好是 LocalParaformerAdapter 的注入形状。 */
export interface RecognizerAssembly {
  readonly module: OfflineRecognizerModule;
  readonly recipe: OfflineRecognizerRecipe;
}

/** 引擎装配来源（与 TenVadSource 同形态）：desktop 组合根读盘/校验/构造 addon，agent 只持端口。 */
export interface RecognizerSource {
  /** 资源缺失或校验失败直接抛错（fail-closed），不回落其它实现。 */
  load(): Promise<RecognizerAssembly>;
}
