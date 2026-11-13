/** `answra` 的命令行语法解析：只负责 argv -> 选项，不读取环境变量或文件系统。 */
import { CliUsageError } from "../cli/errors";

const CODE_COMMAND = "code";
const CONFIG_COMMAND = "config";

export type CliOptions =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "config"; action: "show" }
  | { kind: "config"; action: "unset" }
  | {
      kind: "config";
      action: "set";
      baseUrl: string;
      model: string;
      answerModel?: string;
    }
  | {
      kind: "code";
      cwd?: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      prompt?: string;
      altScreen?: boolean;
    };

/**
 * 解析顶层命令与 `code` 选项。
 *
 * 规则：`--help` / `--version` 优先；非选项的第一个位置参数是命令；`code` 之后
 * 最多一个位置参数作为 prompt；`--` 之后全部按位置参数处理。
 */
export function parseCliOptions(argv: readonly string[]): CliOptions {
  if (argv.length === 0) return { kind: "help" };

  let command: string | undefined;
  let cwd: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;
  let apiKey: string | undefined;
  let prompt: string | undefined;
  let altScreen: boolean | undefined;
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (token === "-h" || token === "--help")) return { kind: "help" };
    if (!optionsEnded && (token === "-v" || token === "--version")) return { kind: "version" };

    if (!optionsEnded && token.startsWith("-")) {
      const option = parseOptionToken(token);
      if (!isKnownOption(option.name)) throw new CliUsageError(`未知选项：${option.name}`);
      if (option.name === "--no-alt-screen") {
        if (option.inlineValue !== undefined) throw new CliUsageError("--no-alt-screen 不接受值。");
        altScreen = false;
        continue;
      }
      const parsed = readOptionValue(argv, index, option.name, option.inlineValue);
      index = parsed.nextIndex;
      switch (option.name) {
        case "--cwd":
          cwd = parsed.value;
          break;
        case "--base-url":
          baseUrl = parsed.value;
          break;
        case "--model":
          model = parsed.value;
          break;
        case "--api-key":
          apiKey = parsed.value;
          break;
      }
      continue;
    }

    if (command === undefined) {
      if (token === CONFIG_COMMAND) return parseConfigCommand(argv.slice(index + 1));
      if (token !== CODE_COMMAND) throw new CliUsageError(`未知命令：${token}`);
      command = token;
      continue;
    }
    if (prompt !== undefined) throw new CliUsageError("只接受一个 prompt 位置参数。");
    prompt = token;
  }

  if (command === undefined) return { kind: "help" };
  return {
    kind: "code",
    ...(cwd === undefined ? {} : { cwd }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(altScreen === undefined ? {} : { altScreen }),
  };
}

function parseOptionToken(token: string): { name: string; inlineValue?: string } {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex < 0) return { name: token };
  return { name: token.slice(0, equalsIndex), inlineValue: token.slice(equalsIndex + 1) };
}

function isKnownOption(
  name: string,
): name is "--cwd" | "--base-url" | "--model" | "--api-key" | "--no-alt-screen" {
  return (
    name === "--cwd" ||
    name === "--base-url" ||
    name === "--model" ||
    name === "--api-key" ||
    name === "--no-alt-screen"
  );
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  name: string,
  inlineValue: string | undefined,
): { value: string; nextIndex: number } {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) throw new CliUsageError(`选项 ${name} 缺少值。`);
    return { value: inlineValue, nextIndex: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) throw new CliUsageError(`选项 ${name} 缺少值。`);
  return { value: next, nextIndex: index + 1 };
}

function parseConfigCommand(args: readonly string[]): CliOptions {
  for (const token of args) {
    if (token === "-h" || token === "--help") return { kind: "help" };
    if (token === "-v" || token === "--version") return { kind: "version" };
  }
  const action = args[0];
  if (action === undefined) {
    throw new CliUsageError("缺少 config 子命令（show|set|unset）。");
  }
  if (action === "show" || action === "unset") {
    if (args.length > 1) throw new CliUsageError(`config ${action} 不接受参数。`);
    return { kind: "config", action };
  }
  if (action === "set") return parseConfigSet(args.slice(1));
  throw new CliUsageError(`未知 config 子命令：${action}`);
}

function parseConfigSet(args: readonly string[]): CliOptions {
  let baseUrl: string | undefined;
  let model: string | undefined;
  let answerModel: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (!token.startsWith("-")) {
      throw new CliUsageError(`config set 不接受位置参数：${token}`);
    }
    const option = parseOptionToken(token);
    if (
      option.name !== "--base-url" &&
      option.name !== "--model" &&
      option.name !== "--answer-model"
    ) {
      throw new CliUsageError(`未知选项：${option.name}`);
    }
    const parsed = readOptionValue(args, index, option.name, option.inlineValue);
    index = parsed.nextIndex;
    switch (option.name) {
      case "--base-url":
        baseUrl = parsed.value;
        break;
      case "--model":
        model = parsed.value;
        break;
      case "--answer-model":
        answerModel = parsed.value;
        break;
    }
  }

  if (baseUrl === undefined || model === undefined) {
    throw new CliUsageError("config set 需要 --base-url 和 --model。");
  }
  return {
    kind: "config",
    action: "set",
    baseUrl,
    model,
    ...(answerModel === undefined ? {} : { answerModel }),
  };
}
