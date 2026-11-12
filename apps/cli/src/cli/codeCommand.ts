/** `answra code` 应用用例：配置、输入、宿主、会话与呈现的接线，不含协议实现。 */

import type { CliOptions } from "../config/cliOptions";
import { resolveModelConfig } from "../config/modelConfig";
import { resolveWorkspaceRoot } from "../config/workspace";
import { createStreamPresenter } from "../presentation/streamPresenter";
import { CodingSession } from "../session/codingSession";
import type { CliDependencies } from "./dependencies";
import { CliUsageError } from "./errors";

type CodeOptions = Extract<CliOptions, { kind: "code" }>;

export async function runCodeCommand(options: CodeOptions, deps: CliDependencies): Promise<number> {
  const workspaceRoot = await resolveWorkspaceRoot(options.cwd ?? deps.cwd);
  const model = resolveModelConfig(options, deps.env);
  const text = (await resolvePrompt(options.prompt, deps)).trim();
  if (!text) throw new CliUsageError("没有可发送的输入。");

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

async function resolvePrompt(prompt: string | undefined, deps: CliDependencies): Promise<string> {
  if (prompt !== undefined) return prompt;
  if (deps.input.isTTY)
    throw new CliUsageError('TUI 尚未接入；请使用 `answra code "..."` 或通过管道提供输入。');
  return deps.input.readAll();
}
