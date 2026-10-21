import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createParaformerRecognizerModule } from "../src/main/interview/asrRecognizer";

const ERROR_HINT = "ASR 预编译资源校验失败";

function fakeResourceBytes(name: string): Buffer {
  // 模型条目只校验哈希不解析内容；凑成 1KB 便于断言不同文件哈希互异。
  const bytes = Buffer.alloc(1_024, name.charCodeAt(0));
  return bytes;
}

async function writeResource(root: string, name: string): Promise<void> {
  await writeFile(join(root, name), fakeResourceBytes(name));
}

async function writeManifest(
  root: string,
  entries: { name: string; sha256: string }[],
): Promise<void> {
  await writeFile(join(root, "manifest.json"), JSON.stringify({ asr: { files: entries } }));
}

describe("createParaformerRecognizerModule（本地 paraformer 资源装配）", () => {
  it("清单缺失时 fail-closed 并提示资源准备命令", async () => {
    const root = await mkdtemp(join(tmpdir(), "answra-asr-res-"));
    try {
      await expect(createParaformerRecognizerModule(root)).rejects.toThrow(ERROR_HINT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("清单结构不合法（asr.files 缺失）时 fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "answra-asr-res-"));
    try {
      await writeFile(join(root, "manifest.json"), JSON.stringify({ asr: {} }));
      await expect(createParaformerRecognizerModule(root)).rejects.toThrow("清单结构不合法");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("清单缺少模型或 tokens 条目时 fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "answra-asr-res-"));
    try {
      await writeManifest(root, [{ name: "model.int8.onnx", sha256: "a".repeat(64) }]);
      await expect(createParaformerRecognizerModule(root)).rejects.toThrow(
        "清单缺少模型/tokens 条目",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("文件哈希与清单不符时 fail-closed 并提示重启准备", async () => {
    const root = await mkdtemp(join(tmpdir(), "answra-asr-res-"));
    try {
      await writeResource(root, "model.int8.onnx");
      await writeResource(root, "tokens.txt");
      await writeManifest(root, [
        {
          name: "model.int8.onnx",
          sha256: createHash("sha256").update("被调包的模型").digest("hex"),
        },
        {
          name: "tokens.txt",
          sha256: createHash("sha256").update(fakeResourceBytes("tokens.txt")).digest("hex"),
        },
      ]);
      await expect(createParaformerRecognizerModule(root)).rejects.toThrow("SHA-256 不匹配");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("清单齐全但文件实际缺失时 fail-closed 并提示重启准备", async () => {
    const root = await mkdtemp(join(tmpdir(), "answra-asr-res-"));
    try {
      await writeManifest(root, [
        { name: "model.int8.onnx", sha256: createHash("sha256").update("不存在").digest("hex") },
        { name: "tokens.txt", sha256: "b".repeat(64) },
      ]);
      await expect(createParaformerRecognizerModule(root)).rejects.toThrow("无法读取");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("哈希全部通过时返回指向已校验文件的装配参数", async () => {
    const root = await mkdtemp(join(tmpdir(), "answra-asr-res-"));
    try {
      const model = fakeResourceBytes("model.int8.onnx");
      const tokens = fakeResourceBytes("tokens.txt");
      await writeFile(join(root, "model.int8.onnx"), model);
      await writeFile(join(root, "tokens.txt"), tokens);
      await writeManifest(root, [
        { name: "model.int8.onnx", sha256: createHash("sha256").update(model).digest("hex") },
        { name: "tokens.txt", sha256: createHash("sha256").update(tokens).digest("hex") },
      ]);
      const setup = await createParaformerRecognizerModule(root);
      expect(setup.recipe.modelPath).toBe(join(root, "model.int8.onnx"));
      expect(setup.recipe.tokensPath).toBe(join(root, "tokens.txt"));
      expect(setup.recipe.numThreads).toBeGreaterThan(0);
      expect(setup.module).toHaveProperty("create");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
