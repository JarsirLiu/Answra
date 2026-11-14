#!/usr/bin/env node
/** CLI development entry: default to coding mode and preserve explicit CLI argv. */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = path.join(root, "apps", "cli");
const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--env-file-if-exists=../../.env",
    "src/main.ts",
    ...(args.length === 0 ? ["code"] : args),
  ],
  { cwd: cliRoot, stdio: "inherit" },
);

child.once("error", (error) => {
  console.error("无法启动 CLI 开发进程。", error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 1);
});
