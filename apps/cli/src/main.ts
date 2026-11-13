#!/usr/bin/env node
/** CLI 可执行入口：只负责把 process 依赖注入应用层并设置退出码。 */
import { randomUUID } from "node:crypto";
import process from "node:process";
import { startCodingHost } from "@answra/agent/composition";
import { createAgentCodingSessionHost } from "./adapters/agentCodingHost";
import { runCli } from "./cli/runCli";
import { loadSharedClientConfig } from "./config/sharedConfig";
import { createProcessInput } from "./transport/input";
import { createStreamOutput } from "./transport/output";
import { createInkTuiRunner } from "./tui/runTui";

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      env: process.env,
      input: createProcessInput(process.stdin),
      output: createStreamOutput(process.stdout, process.stderr),
      cwd: process.cwd(),
      loadSharedClientConfig,
      createSessionHost: ({ emitEvent, onSnapshot, workspaceRoot }) =>
        createAgentCodingSessionHost(startCodingHost({ emitEvent, onSnapshot, workspaceRoot })),
      createConversationId: randomUUID,
      runTui: createInkTuiRunner(),
      onInterrupt: (handler) => {
        const onSigint = (): void => handler();
        process.on("SIGINT", onSigint);
        return () => process.off("SIGINT", onSigint);
      },
    });
  } catch (error) {
    console.error("[answra] 启动失败", error);
    process.exitCode = 1;
  }
}

void main();
