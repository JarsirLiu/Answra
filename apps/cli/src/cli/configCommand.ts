/** `answra config` 用例：只依赖 ModelSettings 端口，不读文件、不解析 argv。 */
import type { CliOptions } from "../config/cliOptions";
import { formatModelSummary } from "../presentation/modelSummary";
import type { CliDependencies } from "./dependencies";

type ConfigOptions = Extract<CliOptions, { kind: "config" }>;

export async function runConfigCommand(
  options: ConfigOptions,
  deps: CliDependencies,
): Promise<number> {
  switch (options.action) {
    case "show":
      deps.output.write(formatModelSummary(await deps.modelSettings.snapshot()));
      return 0;
    case "set": {
      const model = await deps.modelSettings.addLocal({
        baseUrl: options.baseUrl,
        chatModel: options.model,
        ...(options.answerModel === undefined ? {} : { answerModel: options.answerModel }),
      });
      deps.output.write(`已保存本地模型：${model.chat.model}\n`);
      return 0;
    }
    case "unset":
      await deps.modelSettings.clearLocal();
      deps.output.write("已清除共享本地模型配置。\n");
      return 0;
  }
}
