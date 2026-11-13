/** TUI 本地命令目录：帮助、slash 解析与输入补全的唯一元数据来源；不触达 Agent 运行时。 */
export type TuiCommandKind = "help" | "clear" | "exit" | "model";

export interface TuiCommandHelpDetail {
  readonly usage: string;
  readonly summary: string;
}

export interface TuiCommandSpec {
  readonly kind: TuiCommandKind;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  readonly argumentHint?: string;
  /** 帮助页展示用法；缺省由 tuiCommandUsage 生成。 */
  readonly helpUsage?: string;
  /** 帮助页额外用法；首行用法与 summary 由目录自动生成。 */
  readonly helpDetails?: readonly TuiCommandHelpDetail[];
}

export const TUI_COMMANDS: readonly TuiCommandSpec[] = [
  {
    kind: "help",
    name: "help",
    summary: "显示本帮助",
  },
  {
    kind: "clear",
    name: "clear",
    summary: "清空当前会话 transcript",
  },
  {
    kind: "model",
    name: "model",
    summary: "显示当前模型设置",
    argumentHint: "<ID>",
    helpUsage: "/model",
    helpDetails: [
      { usage: "/model <ID>", summary: "切换并保存 chat 模型" },
      { usage: "/model add <URL> <ID> [ANSWER]", summary: "添加本地模型并切换" },
    ],
  },
  {
    kind: "exit",
    name: "exit",
    aliases: ["quit"],
    summary: "退出 TUI（/quit 同义）",
  },
];

export function findTuiCommand(name: string): TuiCommandSpec | undefined {
  const normalized = name.toLowerCase();
  return TUI_COMMANDS.find(
    (command) =>
      command.name === normalized ||
      command.aliases?.some((alias) => alias === normalized) === true,
  );
}

export function suggestTuiCommands(prefix: string): readonly TuiCommandSpec[] {
  const normalized = prefix.toLowerCase();
  if (normalized === "") return TUI_COMMANDS;
  return TUI_COMMANDS.filter(
    (command) =>
      command.name.startsWith(normalized) ||
      command.aliases?.some((alias) => alias.startsWith(normalized)) === true,
  );
}

export function completeTuiCommand(command: TuiCommandSpec): string {
  return `/${command.name}${command.argumentHint === undefined ? "" : " "}`;
}

export function tuiCommandUsage(command: TuiCommandSpec): string {
  return `/${command.name}${command.argumentHint === undefined ? "" : ` ${command.argumentHint}`}`;
}

export function tuiCommandHelpUsage(command: TuiCommandSpec): string {
  return command.helpUsage ?? tuiCommandUsage(command);
}

/** 只有输入以 `/` 开头且尚未输入空白时，才把剩余部分当作命令前缀。 */
export function tuiCommandPrefix(value: string): string | undefined {
  if (!value.startsWith("/") || /\s/.test(value)) return undefined;
  return value.slice(1);
}
