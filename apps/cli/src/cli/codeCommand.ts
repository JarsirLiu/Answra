/** `answra code` 应用用例：配置、输入、宿主、会话与呈现的接线，不含协议实现。 */

import type { CliOptions } from "../config/cliOptions";
import { resolveModelConfig } from "../config/modelConfig";
import { resolveWorkspaceRoot } from "../config/workspace";
import { createStreamPresenter } from "../presentation/streamPresenter";
import { CodingSession } from "../session/codingSession";
import { TuiViewStore } from "../tui/viewStore";
import type { CliDependencies } from "./dependencies";
import { CliUsageError } from "./errors";

type CodeOptions = Extract<CliOptions, { kind: "code" }>;

export async function runCodeCommand(options: CodeOptions, deps: CliDependencies): Promise<number> {
  const workspaceRoot = await resolveWorkspaceRoot(options.cwd ?? deps.cwd);
  const model = resolveModelConfig(options, deps.env);
  const interactive = options.prompt === undefined && deps.input.isTTY;
  const text = (await resolvePrompt(options.prompt, deps)).trim();
  if (!interactive) {
    if (text.length === 0) throw new CliUsageError("没有可发送的输入。");
    return runOnce(text, workspaceRoot, model, deps);
  }
  return runInteractive(workspaceRoot, model, options.altScreen !== false, deps);
}

async function runOnce(
  text: string,
  workspaceRoot: string,
  model: ReturnType<typeof resolveModelConfig>,
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
    model: model.config,
    accessToken: model.accessToken,
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
  model: ReturnType<typeof resolveModelConfig>,
  altScreen: boolean,
  deps: CliDependencies,
): Promise<number> {
  const store = new TuiViewStore();
  const host = deps.createSessionHost({
    emitEvent: (event) => store.applyEvent(event),
    onSnapshot: (snapshot) => store.applySnapshot(snapshot),
    workspaceRoot,
  });
  const session = new CodingSession({
    host,
    conversationId: deps.createConversationId(),
    model: model.config,
    accessToken: model.accessToken,
  });
  const removeInterrupt = deps.onInterrupt(() => {
    session.cancel();
  });

  try {
    return await deps.runTui({
      session,
      store,
      botName: "coding.engineer",
      model: model.config.chat.model,
      workspaceRoot,
      altScreen,
    });
  } finally {
    removeInterrupt();
    store.dispose();
    session.close();
  }
}

async function resolvePrompt(prompt: string | undefined, deps: CliDependencies): Promise<string> {
  if (prompt !== undefined) return prompt;
  if (deps.input.isTTY) return "";
  return deps.input.readAll();
}
