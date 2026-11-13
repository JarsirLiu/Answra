/** TUI `/model` 执行：只依赖 ModelSettings、会话端口与视图 store。 */
import type { ConversationModelConfig } from "@answra/shared";
import type { ModelSettings } from "../../model/ports";
import { modelSummaryLines } from "../../presentation/modelSummary";
import type { CodingSession } from "../../session/codingSession";
import type { TuiViewStore } from "../app/viewStore";

const ADD_MIN_ARGS = 2;
const ADD_MAX_ARGS = 3;

export interface ModelCommandDeps {
  readonly busy: boolean;
  readonly session?: Pick<CodingSession, "setModel">;
  readonly configureSession?: (model: ConversationModelConfig) => Promise<void>;
  readonly store: TuiViewStore;
  readonly modelSettings: ModelSettings;
}

export async function handleModelCommand(
  args: readonly string[],
  deps: ModelCommandDeps,
): Promise<void> {
  const [action, ...rest] = args;
  if (action === undefined) {
    deps.store.setNotice(modelSummaryLines(await deps.modelSettings.snapshot()));
    return;
  }
  if (action === "add") {
    requireIdle(deps);
    await addLocal(rest, deps);
    return;
  }
  if (rest.length > 0) throw new Error("用法：/model <ID>。");
  requireIdle(deps);
  await applyModel(await deps.modelSettings.switchChatModel(action), deps);
}

async function addLocal(args: readonly string[], deps: ModelCommandDeps): Promise<void> {
  if (args.length < ADD_MIN_ARGS || args.length > ADD_MAX_ARGS) {
    throw new Error("用法：/model add <base-url> <model-id> [answer-model]。");
  }
  const [baseUrl, chatModel, answerModel] = args;
  await applyModel(
    await deps.modelSettings.addLocal({
      baseUrl: baseUrl ?? "",
      chatModel: chatModel ?? "",
      ...(answerModel === undefined ? {} : { answerModel }),
    }),
    deps,
  );
}

async function applyModel(model: ConversationModelConfig, deps: ModelCommandDeps): Promise<void> {
  if (deps.session !== undefined) {
    deps.session.setModel(model);
  } else if (deps.configureSession !== undefined) {
    await deps.configureSession(model);
  } else {
    throw new Error("模型会话尚未创建。");
  }
  deps.store.setModelLabel(model.chat.model);
  deps.store.setNotice([`已切换模型：${model.chat.model}`]);
}

function requireIdle(deps: ModelCommandDeps): void {
  if (deps.busy) throw new Error("当前运行中，先按 Esc 中断后再切换模型。");
}
