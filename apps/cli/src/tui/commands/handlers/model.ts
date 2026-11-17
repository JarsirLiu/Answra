/** 模型类命令：/config 与 /model；只执行，不判断运行状态。 */
import type { TuiCommandDeps } from "../ports";

const MODEL_NOTICE_KEY = "model";

export function handleConfig(args: readonly string[], deps: TuiCommandDeps): void {
  if (args.length > 0) {
    deps.store.notify({
      key: MODEL_NOTICE_KEY,
      text: "/config 不接受参数。",
      tone: "warning",
    });
    return;
  }
  deps.openPanel("config");
}

export async function handleModel(args: readonly string[], deps: TuiCommandDeps): Promise<void> {
  const [action, ...rest] = args;
  if (action === undefined) {
    deps.openPanel("model");
    return;
  }
  if (action === "add") throw new Error("已改用 /config 修改完整模型配置。");
  if (rest.length > 0) throw new Error("用法：/model <ID>。");
  const model = await deps.modelSettings.switchChatModel(action);
  const session = deps.getSession();
  if (session !== undefined) {
    session.setModel(model);
  } else {
    await deps.configureSession(model);
  }
  deps.store.setModelLabel(model.chat.model);
  deps.store.notify({
    key: MODEL_NOTICE_KEY,
    text: `已切换模型：${model.chat.model}`,
    tone: "success",
  });
}
