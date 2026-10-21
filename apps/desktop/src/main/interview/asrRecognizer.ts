import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { OfflineRecognizerModule, OfflineRecognizerRecipe } from "@answra/agent";
import { OfflineRecognizer as SherpaOfflineRecognizerConstructor } from "sherpa-onnx-node";

/**
 * 本地 paraformer 引擎装配：读取 resources/asr/manifest.json（由
 * `pnpm --filter @answra/desktop asr:prepare` 生成）并逐文件 SHA-256 校验，
 * 把 sherpa-onnx 预编译 addon 适配成 agent 的 OfflineRecognizerModule。
 * 校验或 addon 加载失败直接抛错（fail-closed），不回落任何替代实现。
 */

const RESOURCE_ERROR_HINT =
  "ASR 预编译资源校验失败；请运行 pnpm --filter @answra/desktop asr:prepare 后重试";

const MODEL_FILE_NAME = "model.int8.onnx";
const TOKENS_FILE_NAME = "tokens.txt";

// CPU 解码实测吞吐取点（与评测 harness 一致）；引擎差速后调整须复测 RTF。
const RECOGNIZER_NUM_THREADS = 4;

export interface ParaformerRecognizerSetup {
  module: OfflineRecognizerModule;
  recipe: OfflineRecognizerRecipe;
}

export async function createParaformerRecognizerModule(
  resourceRoot: string,
): Promise<ParaformerRecognizerSetup> {
  const { modelPath, tokensPath } = await readVerifiedPaths(resourceRoot);
  const module: OfflineRecognizerModule = {
    create: (recipe) => {
      const recognizer = new SherpaOfflineRecognizerConstructor({
        modelConfig: {
          paraformer: { model: recipe.modelPath },
          tokens: recipe.tokensPath,
          numThreads: recipe.numThreads,
          debug: 0,
          provider: "cpu",
        },
      });
      return {
        // stream 生命周期在注入侧闭合：一次整段 create→accept→decode→getResult。
        transcribeOnce: ({ samples, sampleRate }) => {
          const stream = recognizer.createStream();
          stream.acceptWaveform({ samples, sampleRate });
          recognizer.decode(stream);
          return recognizer.getResult(stream).text;
        },
      };
    },
  };
  return {
    module,
    recipe: {
      modelPath,
      tokensPath,
      numThreads: RECOGNIZER_NUM_THREADS,
    },
  };
}

interface AsrRuntimeManifest {
  asr?: { files?: unknown };
}

interface AsrManifestFile {
  name: string;
  sha256: string;
}

async function readVerifiedPaths(
  resourceRoot: string,
): Promise<{ modelPath: string; tokensPath: string }> {
  const manifest = await readManifest(resourceRoot);
  const model = manifest.get(MODEL_FILE_NAME);
  const tokens = manifest.get(TOKENS_FILE_NAME);
  if (!model || !tokens) throw new Error(`${RESOURCE_ERROR_HINT}（清单缺少模型/tokens 条目）`);

  const modelPath = join(resourceRoot, MODEL_FILE_NAME);
  const tokensPath = join(resourceRoot, TOKENS_FILE_NAME);
  await verifyFile(modelPath, model.sha256);
  await verifyFile(tokensPath, tokens.sha256);
  return { modelPath, tokensPath };
}

async function readManifest(resourceRoot: string): Promise<Map<string, AsrManifestFile>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(resourceRoot, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(`${RESOURCE_ERROR_HINT}：无法读取清单（${describe(error)}）`);
  }
  const files = (raw as AsrRuntimeManifest)?.asr?.files;
  if (!Array.isArray(files)) throw new Error(`${RESOURCE_ERROR_HINT}（清单结构不合法）`);
  const entries = new Map<string, AsrManifestFile>();
  for (const file of files) {
    if (
      typeof file === "object" &&
      file !== null &&
      "name" in file &&
      "sha256" in file &&
      typeof file.name === "string" &&
      typeof file.sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(file.sha256)
    ) {
      entries.set(file.name, { name: file.name, sha256: file.sha256 });
      continue;
    }
    throw new Error(`${RESOURCE_ERROR_HINT}（清单条目不完整）`);
  }
  return entries;
}

async function verifyFile(filePath: string, expectedSha256: string): Promise<void> {
  const hash = createHash("sha256");
  try {
    // 模型文件超过 80MB：流式哈希校验，不整块读进内存。
    await pipeline(createReadStream(filePath), hash);
  } catch (error) {
    throw new Error(`${RESOURCE_ERROR_HINT}：无法读取 ${basename(filePath)}（${describe(error)}）`);
  }
  const actual = hash.digest("hex");
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `${RESOURCE_ERROR_HINT}：SHA-256 不匹配（期望 ${expectedSha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
