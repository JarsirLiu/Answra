/** 顶层命令分派：解析 argv、处理 help/version，再把 code 交给应用用例。 */
import { parseCliOptions } from "../config/cliOptions";
import { CLI_VERSION } from "../version";
import { runCodeCommand } from "./codeCommand";
import type { CliDependencies } from "./dependencies";
import { CliUsageError } from "./errors";
import { CLI_HELP } from "./help";

export async function runCli(argv: readonly string[], deps: CliDependencies): Promise<number> {
  let options: ReturnType<typeof parseCliOptions>;
  try {
    options = parseCliOptions(argv);
  } catch (error) {
    return reportError(deps, error);
  }

  if (options.kind === "help") {
    deps.output.write(CLI_HELP);
    return 0;
  }
  if (options.kind === "version") {
    deps.output.write(`answra ${CLI_VERSION}\n`);
    return 0;
  }

  try {
    return await runCodeCommand(options, deps);
  } catch (error) {
    return reportError(deps, error);
  }
}

function reportError(deps: CliDependencies, error: unknown): number {
  deps.output.writeError(`error: ${messageOf(error)}\n`);
  if (error instanceof CliUsageError) {
    deps.output.writeError("运行 `answra --help` 查看用法。\n");
    return 2;
  }
  return 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
