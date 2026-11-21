#!/usr/bin/env node
/** CLI 可执行入口：只负责把 process 依赖注入应用层并设置退出码。 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import process from "node:process";
import { SqliteConversationStore, startCodingHost } from "@answra/agent/composition";
import { resolveDefaultConfigDir } from "@answra/config";
import { createSystemModelCredentialStore } from "@answra/credentials";
import {
  createNodeSignalingTimers,
  createRemoteSignalingService,
  NodeWebRtcLink,
} from "@answra/remote-node";
import { createAgentCodingSessionHost } from "./adapters/agentCodingHost";
import { withLocalProviderProfiles } from "./adapters/localProviderProfiles";
import { createOpenAiModelCatalog } from "./adapters/openAiModelCatalog";
import { createSharedModelStore } from "./adapters/sharedModelStore";
import { runCli } from "./cli/runCli";
import { isPackagedCliRuntime, resolveCliCloudEndpoints } from "./config/cloudEndpoints";
import { resolveCliInstructionFile } from "./config/instructionFile";
import { resolveCliSkillRoots } from "./config/skillRoots";
import { ModelSettingsService } from "./model/settingsService";
import { resolveCliDeviceDescriptor } from "./remote/auth/deviceInfo";
import { createKeychainServiceAuthStore } from "./remote/auth/keychainServiceAuthStore";
import { createLocalAuthorizationCallback } from "./remote/auth/localAuthCallback";
import { RemoteAuthService } from "./remote/auth/remoteAuthService";
import { createFileRemoteHostKeyStore } from "./remote/credentials/fileRemoteHostKeyStore";
import { createRemoteCodingHost } from "./remote/host/commandPort";
import { createProcessInput } from "./transport/input";
import { openSystemBrowser } from "./transport/openBrowser";
import { createStreamOutput } from "./transport/output";
import { onProcessInterrupt } from "./transport/processSignals";
import { createProcessSecretPrompt } from "./transport/secretPrompt";
import { createInkTuiRunner } from "./tui/runTui";

async function main(): Promise<void> {
  try {
    const modelSettings = withLocalProviderProfiles(
      new ModelSettingsService(createSharedModelStore()),
    );
    const modelCredentials = createSystemModelCredentialStore();
    const sessionStore = new SqliteConversationStore(
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
    try {
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
              globalInstructionFile: resolveCliInstructionFile(),
              skillRoots: resolveCliSkillRoots(workspaceRoot),
            }),
          ),
        createConversationId: randomUUID,
        runTui: createInkTuiRunner(),
        onInterrupt: (handler) => onProcessInterrupt(handler),
      });
    } finally {
      await sessionStore.close();
    }
  } catch (error) {
    console.error("[answra] 启动失败", error);
    process.exitCode = 1;
  }
}

void main();
