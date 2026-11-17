/** TUI 本地命令目录：帮助、slash 解析与输入补全的唯一元数据来源；不触达 Agent 运行时。 */
export type TuiCommandKind =
  | "help"
  | "clear"
  | "new"
  | "sessions"
  | "resume"
  | "delete"
  | "compact"
  | "config"
  | "exit"
  | "model"
  | "login"
  | "logout"
  | "status"
  | "remote";

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
    kind: "new",
    name: "new",
    summary: "新建会话并回到欢迎页",
  },
  {
    kind: "sessions",
    name: "sessions",
    summary: "列出当前 workspace 的历史会话",
  },
  {
    kind: "resume",
    name: "resume",
    summary: "恢复历史会话",
    argumentHint: "<ID|前缀>",
  },
  {
    kind: "delete",
    name: "delete",
    summary: "删除历史会话",
    argumentHint: "<ID>",
  },
  {
    kind: "compact",
    name: "compact",
    summary: "压缩当前会话上下文，可附加摘要指令",
    argumentHint: "[instructions]",
    helpUsage: "/compact [instructions]",
  },
  {
    kind: "config",
    name: "config",
    summary: "编辑本地模型配置",
    helpUsage: "/config",
  },
  {
    kind: "model",
    name: "model",
    summary: "选择或切换模型",
    argumentHint: "<ID>",
    helpUsage: "/model",
    helpDetails: [{ usage: "/model <ID>", summary: "切换并保存 chat 模型" }],
  },
  { kind: "login", name: "login", summary: "打开浏览器登录 Answra 账号" },
  { kind: "logout", name: "logout", summary: "退出 Answra 账号" },
  { kind: "status", name: "status", summary: "查看账号登录状态" },
  { kind: "remote", name: "remote", summary: "生成持久远程连接码并开启 host" },
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

export function suggestTuiCommands(
  prefix: string,
  recentNames: readonly string[] = [],
): readonly TuiCommandSpec[] {
  const normalized = prefix.toLowerCase();
  if (normalized === "") {
    const seen = new Set<string>();
    const ordered: TuiCommandSpec[] = [];
    for (const name of recentNames) {
      const command = findTuiCommand(name);
      if (command !== undefined && !seen.has(command.name)) {
        seen.add(command.name);
        ordered.push(command);
      }
    }
    for (const command of TUI_COMMANDS) {
      if (!seen.has(command.name)) ordered.push(command);
    }
    return ordered;
  }
  return TUI_COMMANDS.map((command, index) => ({
    command,
    index,
    score: commandMatchScore(command, normalized),
  }))
    .filter(
      (entry): entry is { command: TuiCommandSpec; index: number; score: number } =>
        entry.score !== undefined,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.command);
}

function commandMatchScore(command: TuiCommandSpec, query: string): number | undefined {
  if (command.name === query) return 0;
  if (command.aliases?.includes(query) === true) return 1;
  if (command.name.startsWith(query)) return 2;
  if (command.aliases?.some((alias) => alias.startsWith(query)) === true) return 3;
  if (command.summary.toLowerCase().includes(query)) return 4;
  return undefined;
}

/** 命令名后没有参数，或只有恰好一个尾随空格时，返回该命令的参数提示。 */
export function tuiCommandArgumentHint(value: string): string | undefined {
  const match = /^\/([^\s]+)( ?)$/.exec(value);
  const name = match?.[1];
  if (name === undefined) return undefined;
  return findTuiCommand(name)?.argumentHint;
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
