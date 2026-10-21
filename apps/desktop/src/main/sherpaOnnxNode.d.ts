/**
 * sherpa-onnx-node 1.13.8 无自带类型声明；按运行时实测固定的最小声明面，
 * 只声明组合根（asrRecognizer）实际用到的那部分 API。
 */
declare module "sherpa-onnx-node" {
  export interface SherpaOfflineRecognizerStream {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  }

  export interface SherpaOfflineRecognizer {
    createStream(): SherpaOfflineRecognizerStream;
    decode(stream: SherpaOfflineRecognizerStream): void;
    getResult(stream: SherpaOfflineRecognizerStream): { text: string };
  }

  export const OfflineRecognizer: new (config: unknown) => SherpaOfflineRecognizer;
}
