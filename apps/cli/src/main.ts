#!/usr/bin/env node
/** CLI 可执行入口：只负责把 process 依赖注入应用层并设置退出码。 */
import { randomUUID } from "node:crypto";
import process from "node:process";
import { startCodingHost } from "@answra/agent/composition";
import { createAgentCodingSessionHost } from "./adapters/agentCodingHost";
import { createSharedModelStore } from "./adapters/sharedModelStore";
import { runCli } from "./cli/runCli";
import { ModelSettingsService } from "./model/settingsService";
import { createFileRemoteCredentialStore } from "./remote/credentials/fileRemoteCredentialStore";
import { createFileRemoteHostKeyStore } from "./remote/credentials/fileRemoteHostKeyStore";
import { createProcessInput } from "./transport/input";
import { createStreamOutput } from "./transport/output";
import { createProcessSecretPrompt } from "./transport/secretPrompt";
import { createInkTuiRunner } from "./tui/runTui";

async function main(): Promise<void> {
  try {
    const modelSettings = new ModelSettingsService(createSharedModelStore());
    process.exitCode = await runCli(process.argv.slice(2), {
      env: process.env,
      input: createProcessInput(process.stdin),
      output: createStreamOutput(process.stdout, process.stderr),
      cwd: process.cwd(),
      modelSettings,
      remoteKeys: {
        hostKeys: createFileRemoteHostKeyStore(),
        credentials: createFileRemoteCredentialStore(),
        promptSecret: createProcessSecretPrompt(process.stdin, process.stdout),
      },
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
