/** `answra code` 应用用例：配置、输入、宿主、会话与呈现的接线，不含协议实现。 */

import {
  AI_SERVICE_BASE_URL,
  CLI_API_KEY,
  CLI_MODEL,
  type ConversationModelConfig,
} from "@answra/shared";
import type { CliOptions } from "../config/cliOptions";
import { resolveWorkspaceRoot } from "../config/workspace";
import { resolveModelAccessToken } from "../model/accessToken";
import { MissingModelConfigError } from "../model/errors";
import type { ModelOverrides } from "../model/ports";
import { createStreamPresenter } from "../presentation/streamPresenter";
import { CodingSession } from "../session/codingSession";
import { TuiViewStore } from "../tui/app/viewStore";
import type { CliDependencies } from "./dependencies";
import { CliUsageError } from "./errors";
import { startRemoteHostWithConnectionCode } from "./remoteSessionCommands";

type CodeOptions = Extract<CliOptions, { kind: "code" }>;

export async function runCodeCommand(options: CodeOptions, deps: CliDependencies): Promise<number> {
  const workspaceRoot = await resolveWorkspaceRoot(options.cwd ?? deps.cwd);
  const explicitAccessToken = (options.apiKey ?? deps.env[CLI_API_KEY] ?? "").trim();
  const interactive = options.prompt === undefined && deps.input.isTTY;
  const text = (await resolvePrompt(options.prompt, deps)).trim();
  if (!interactive) {
    if (text.length === 0) throw new CliUsageError("没有可发送的输入。");
    const model = await deps.modelSettings.resolve(modelOverrides(options, deps));
    const accessToken = await resolveAccessToken(explicitAccessToken, deps);
    return runOnce(text, workspaceRoot, model, accessToken, deps);
  }
  const model = await resolveInteractiveModel(options, deps);
  const accessToken =
    model === undefined ? explicitAccessToken : await resolveAccessToken(explicitAccessToken, deps);
  return runInteractive(workspaceRoot, model, accessToken, options.altScreen !== false, deps);
}

async function resolveInteractiveModel(
  options: CodeOptions,
  deps: CliDependencies,
): Promise<ConversationModelConfig | undefined> {
  try {
    return await deps.modelSettings.resolve(modelOverrides(options, deps));
  } catch (error) {
    if (error instanceof MissingModelConfigError) return undefined;
    throw error;
  }
}

function modelOverrides(options: CodeOptions, deps: CliDependencies): readonly ModelOverrides[] {
  return [
    { baseUrl: options.baseUrl, chatModel: options.model },
    { baseUrl: deps.env[AI_SERVICE_BASE_URL], chatModel: deps.env[CLI_MODEL] },
  ];
}

async function resolveAccessToken(
  explicitAccessToken: string,
  deps: CliDependencies,
): Promise<string> {
  return resolveModelAccessToken(explicitAccessToken, deps.modelCredentials);
}

async function runOnce(
  text: string,
  workspaceRoot: string,
  model: ConversationModelConfig,
  accessToken: string,
  deps: CliDependencies,
): Promise<number> {
  const presenter = createStreamPresenter(deps.output);
  const host = deps.createSessionHost({
    emitEvent: (event) => presenter.present(event),
    workspaceRoot,
  });
  const session = new CodingSession({
    host,
    conversationId: deps.createConversationId(),
    model,
    accessToken,
  });
  const removeInterrupt = deps.onInterrupt(() => {
    session.cancel();
  });

  try {
    await session.open();
    const runId = await session.send(text);
    await session.wait(runId);
    return presenter.exitCode;
  } finally {
    removeInterrupt();
    session.close();
    presenter.finish();
  }
}

async function runInteractive(
  workspaceRoot: string,
  initialModel: ConversationModelConfig | undefined,
  accessToken: string,
  altScreen: boolean,
  deps: CliDependencies,
): Promise<number> {
  const store = new TuiViewStore();
  let session: CodingSession | undefined;
  let removeInterrupt: (() => void) | undefined;

  const createSession = (
    model: ConversationModelConfig,
    accessTokenOverride?: string,
  ): CodingSession => {
    const host = deps.createSessionHost({
      emitEvent: (event) => store.applyEvent(event),
      onSnapshot: (snapshot) => store.applySnapshot(snapshot),
      workspaceRoot,
    });
    const next = new CodingSession({
      host,
      conversationId: deps.createConversationId(),
      model,
      accessToken: accessTokenOverride ?? accessToken,
    });
    removeInterrupt?.();
    removeInterrupt = deps.onInterrupt(() => next.cancel());
    session = next;
    return next;
  };

  const initial =
    initialModel === undefined
      ? undefined
      : { session: createSession(initialModel), model: initialModel.chat.model };

  try {
    return await deps.runTui({
      ...(initial ?? {}),
      createSession,
      store,
      modelSettings: deps.modelSettings,
      modelCredentials: deps.modelCredentials,
      modelCatalog: deps.modelCatalog,
      botName: "coding.engineer",
      workspaceRoot,
      altScreen,
      remoteAuth: deps.remoteAuth,
      openBrowser: deps.openBrowser,
      startRemoteHost:
        deps.remoteKeys === undefined || deps.remoteRuntime === undefined
          ? undefined
          : () =>
              startRemoteHostWithConnectionCode(deps, workspaceRoot, (line) =>
                store.setNotice([line]),
              ),
    });
  } finally {
    removeInterrupt?.();
    store.dispose();
    session?.close();
  }
}

async function resolvePrompt(prompt: string | undefined, deps: CliDependencies): Promise<string> {
  if (prompt !== undefined) return prompt;
  if (deps.input.isTTY) return "";
  return deps.input.readAll();
}
