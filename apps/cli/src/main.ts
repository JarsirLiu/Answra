#!/usr/bin/env node
/** CLI 可执行入口：只负责把 process 依赖注入应用层并设置退出码。 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import process from "node:process";
import { FileConversationStore, startCodingHost } from "@answra/agent/composition";
import { resolveDefaultConfigDir } from "@answra/config";
import { createSystemModelCredentialStore } from "@answra/credentials";
import { createAgentCodingSessionHost } from "./adapters/agentCodingHost";
import { createOpenAiModelCatalog } from "./adapters/openAiModelCatalog";
import { createSharedModelStore } from "./adapters/sharedModelStore";
import { runCli } from "./cli/runCli";
import { isPackagedCliRuntime, resolveCliCloudEndpoints } from "./config/cloudEndpoints";
import { ModelSettingsService } from "./model/settingsService";
import { resolveCliDeviceDescriptor } from "./remote/auth/deviceInfo";
import { createKeychainServiceAuthStore } from "./remote/auth/keychainServiceAuthStore";
import { createLocalAuthorizationCallback } from "./remote/auth/localAuthCallback";
import { RemoteAuthService } from "./remote/auth/remoteAuthService";
import { createFileRemoteCredentialStore } from "./remote/credentials/fileRemoteCredentialStore";
import { createFileRemoteHostKeyStore } from "./remote/credentials/fileRemoteHostKeyStore";
import { createRemoteCodingHost } from "./remote/host/commandPort";
import { createNodeSignalingTimers } from "./remote/signaling/nodeTimers";
import { createRemoteSignalingService } from "./remote/signaling/remoteSignalingService";
import { NodeWebRtcLink } from "./remote/transport/nodeWebRtcLink";
import { createProcessInput } from "./transport/input";
import { openSystemBrowser } from "./transport/openBrowser";
import { createStreamOutput } from "./transport/output";
import { createProcessSecretPrompt } from "./transport/secretPrompt";
import { createInkTuiRunner } from "./tui/runTui";

async function main(): Promise<void> {
  try {
    const modelSettings = new ModelSettingsService(createSharedModelStore());
    const modelCredentials = createSystemModelCredentialStore();
    const sessionStore = new FileConversationStore(
      join(resolveDefaultConfigDir(), "cli", "sessions"),
    );
    const promptSecret = createProcessSecretPrompt(process.stdin, process.stdout);
    const endpoints = resolveCliCloudEndpoints(process.env, {
      isPackaged: isPackagedCliRuntime(),
    });
    const remoteAuth = new RemoteAuthService({
      store: createKeychainServiceAuthStore(),
      device: () => resolveCliDeviceDescriptor(),
      promptCode: promptSecret,
      siteBaseUrl: endpoints.siteBaseUrl,
      apiBaseUrl: endpoints.apiBaseUrl,
      createAuthorizationCallback: createLocalAuthorizationCallback,
    });
    process.exitCode = await runCli(process.argv.slice(2), {
      env: process.env,
      input: createProcessInput(process.stdin),
      output: createStreamOutput(process.stdout, process.stderr),
      cwd: process.cwd(),
      modelSettings,
      modelCredentials,
      modelCatalog: createOpenAiModelCatalog(),
      remoteKeys: {
        hostKeys: createFileRemoteHostKeyStore(),
        credentials: createFileRemoteCredentialStore(),
        promptSecret,
      },
      remoteAuth,
      remoteRuntime: {
        signaling: createRemoteSignalingService({
          baseUrl: endpoints.apiBaseUrl,
          getAccessToken: () => remoteAuth.getAccessToken(),
        }),
        timers: createNodeSignalingTimers(),
        createLink: (options) => new NodeWebRtcLink(options),
        createId: randomUUID,
      },
      createRemoteHost: createRemoteCodingHost,
      openBrowser: openSystemBrowser,
      createSessionHost: ({ emitEvent, onSnapshot, workspaceRoot }) =>
        createAgentCodingSessionHost(
          startCodingHost({
            emitEvent,
            onSnapshot,
            workspaceRoot,
            store: sessionStore,
            catalog: sessionStore,
          }),
        ),
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
