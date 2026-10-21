import { TEN_VAD_ONSET_THRESHOLD } from "@answra/agent";
import { createTenVadFileSource } from "../src/main/interview/tenVadResources";

/**
 * VAD 打包回归探针：由 tenVadBundle.test.ts 用与 build-electron 相同的 esbuild
 * 选项打包成 CJS 后以 node 直接执行，证明 utility process 的 bundle 形态下
 * 预编译资源加载与一次 hop 推理可完成。成功时把静音判决写成单行 JSON；
 * 任何失败走非零退出，由测试断言代价。
 */
async function main() {
  const resourceRoot = process.argv[2];
  if (typeof resourceRoot !== "string" || resourceRoot.length === 0)
    throw new Error("VAD bundle 探针缺少资源目录参数");
  const engine = await createTenVadFileSource(resourceRoot).load();
  // 检测阈值随 agent 的生产常量走：阶段 8 校准后本探针自动跟进，不另立真源。
  const hop = engine.createHop(TEN_VAD_ONSET_THRESHOLD);
  const verdict = hop.processHop(new Int16Array(engine.hopSamples));
  engine.destroyHop(hop);
  console.log(JSON.stringify(verdict));
}

main().catch((error) => {
  console.error("VAD bundle 探针失败", error);
  process.exit(1);
});
