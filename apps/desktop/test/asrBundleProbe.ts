import { createParaformerRecognizerModule } from "../src/main/interview/asrRecognizer";

/**
 * ASR 打包回归探针：由 asrBundle.test.ts 用与 build-electron.mjs worker 产物
 * 相同的 esbuild 选项打包成 CJS 后以 node 直接执行，证明 utility process 的
 * bundle 形态下 sherpa-onnx addon 解析、模型加载与一次整段解码可完成。
 * 成功时把解码结果写成单行 JSON；任何失败走非零退出，由测试断言代价。
 */
async function main() {
  const resourceRoot = process.argv[2];
  if (typeof resourceRoot !== "string" || resourceRoot.length === 0)
    throw new Error("ASR bundle 探针缺少资源目录参数");
  const setup = await createParaformerRecognizerModule(resourceRoot);
  const recognizer = setup.module.create(setup.recipe);
  // 0.1s 静音：只证明完整解码链路可跑通（空转写是合法结果），不用于质量判断。
  const text = recognizer.transcribeOnce({
    samples: new Float32Array(1_600),
    sampleRate: 16_000,
  });
  console.log(JSON.stringify({ text }));
}

main().catch((error) => {
  console.error("ASR bundle 探针失败", error);
  process.exit(1);
});
