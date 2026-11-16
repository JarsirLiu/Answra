/** RunCommand 的模型提示：按实际 shell 说明语法差异，不参与进程构造。 */

import type { ShellRuntime } from "./shell/runtime";

export function buildRunCommandDescription(runtime: ShellRuntime): string {
  const shellNotes =
    runtime.kind === "powershell"
      ? [
          "- Shell: Windows PowerShell 5.1 (powershell.exe).",
          "- Use `$LASTEXITCODE` for exit codes and `Get-Command` instead of `where`.",
          "- `&&` is not supported; chain dependent commands with `cmd1; if ($?) { cmd2 }`.",
          "- Paths use Windows separators.",
        ]
      : runtime.kind === "pwsh"
        ? [
            "- Shell: PowerShell 7+ (pwsh).",
            "- Use `$LASTEXITCODE` for exit codes and `Get-Command` instead of `where`.",
            "- `&&` is supported; paths use the current platform separator.",
          ]
        : runtime.kind === "cmd"
          ? [
              "- Shell: cmd.exe.",
              "- Use `%VAR%` for environment variables and `&&` for dependent commands.",
              "- Paths use Windows separators.",
            ]
          : [
              `- Shell: ${runtime.displayName} (POSIX).`,
              "- Use POSIX quoting and `/` path separators; `&&` is supported.",
            ];
  return [
    "Executes a shell command or continues an existing shell session in the current workspace.",
    "",
    ...shellNotes,
    "- Multiple statements run in one shell process, so variables and state persist.",
    "- Omit `sessionId` to start a command; `command` is then required.",
    "- A command that runs longer than `yieldTimeMs` returns a `sessionId`.",
    "- To continue that session, call RunCommand with `sessionId` instead of `command`; optional `chars` writes stdin.",
    "- `workdir` and `timeoutMs` apply only when starting a command.",
    "- Without `yieldTimeMs`, a one-shot command runs to completion or its process timeout.",
  ].join("\n");
}
