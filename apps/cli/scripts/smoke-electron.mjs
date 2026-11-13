import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = resolve(appRoot, "../desktop");
const electronBinary = process.env.ANSWRA_ELECTRON_BIN ?? defaultElectronBinary();
const cliBundle = process.env.ANSWRA_CLI_BUNDLE ?? join(appRoot, "dist/main.mjs");
const smokeTimeoutMs = 20_000;

function defaultElectronBinary() {
  if (process.platform === "darwin") {
    return join(desktopRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  }
  return join(
    desktopRoot,
    process.platform === "win32"
      ? "node_modules/electron/dist/electron.exe"
      : "node_modules/electron/dist/electron",
  );
}

async function requireFile(path, label) {
  try {
    await stat(path);
  } catch {
    throw new Error(`${label} 不存在：${path}`);
  }
}

function startFakeServer() {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (payload) => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      send({
        id: "chatcmpl-smoke",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "smoke",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hello from fake" },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "chatcmpl-smoke",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "smoke",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolveListen(server);
    });
  });
}

function runNode(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(electronBinary, args, {
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => finish(resolveRun, { code, signal, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`CLI smoke 超时（${smokeTimeoutMs}ms）：${args.join(" ")}`));
    }, smokeTimeoutMs);
  });
}

async function main() {
  await requireFile(electronBinary, "Electron 二进制");
  await requireFile(cliBundle, "CLI bundle");

  const version = await runNode([cliBundle, "--version"]);
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout, /^answra \d+\.\d+\.\d+\n$/);

  const help = await runNode([cliBundle, "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /用法：/);

  const unknown = await runNode([cliBundle, "code", "--bad"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /未知选项/);

  const missingConfig = await runNode([cliBundle, "code", "hi"], {
    ANSWRA_AI_BASE_URL: "",
    ANSWRA_MODEL: "",
    ANSWRA_API_KEY: "",
  });
  assert.equal(missingConfig.code, 1);
  assert.match(missingConfig.stderr, /缺少 ANSWRA_AI_BASE_URL/);

  const server = await startFakeServer();
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("假模型服务没有取得监听端口");
    }
    const response = await runNode([cliBundle, "code", "say hi"], {
      ANSWRA_AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      ANSWRA_MODEL: "smoke",
      ANSWRA_API_KEY: "test",
    });
    assert.equal(response.code, 0, response.stderr);
    assert.match(response.stdout, /Hello from fake/);
  } finally {
    await new Promise((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }

  process.stdout.write(`CLI Electron Node smoke 通过：${electronBinary}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
