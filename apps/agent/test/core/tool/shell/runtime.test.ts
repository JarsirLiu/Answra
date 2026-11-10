import { describe, expect, it } from "vitest";
import {
  buildShellInvocation,
  decodeShellOutput,
  resolveShellRuntime,
  stripPowerShellErrorWrapper,
  truncateShellOutput,
} from "../../../../src/core/tool/builtin/shell/runtime";

describe("shell runtime resolution", () => {
  it("reports Windows PowerShell even when SHELL points at a POSIX shell", () => {
    const runtime = resolveShellRuntime({ platform: "win32", shell: "/bin/bash" });

    expect(runtime).toEqual({
      executable: "powershell.exe",
      displayName: "Windows PowerShell 5.1 (powershell.exe)",
      syntax: "powershell",
    });
  });

  it("reports the configured POSIX shell used by the invocation", () => {
    const runtime = resolveShellRuntime({ platform: "linux", shell: "/bin/zsh" });

    expect(runtime).toEqual({
      executable: "/bin/zsh",
      displayName: "/bin/zsh",
      syntax: "posix",
    });
    expect(
      buildShellInvocation("echo ok", { platform: "linux", shell: "/bin/zsh" }).executable,
    ).toBe(runtime.executable);
  });
});

describe("shell runtime invocation", () => {
  it("uses PowerShell and puts encoding, command, and exit-code trailer in one script", () => {
    const invocation = buildShellInvocation('Write-Output "ok"', { platform: "win32" });

    expect(invocation.executable).toBe("powershell.exe");
    expect(invocation.args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    const script = invocation.args[4];
    expect(script).toContain("$PSDefaultParameterValues");
    expect(script).toContain('Write-Output "ok"');
    expect(script).toContain("if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }");
  });

  it("places the Windows Job Object bootstrap before the user command", () => {
    const invocation = buildShellInvocation('Write-Output "ok"', {
      platform: "win32",
      windowsBootstrap: "$__answraJobContained = $true",
    });
    const script = invocation.args[4];

    expect(script?.indexOf("$__answraJobContained = $true")).toBeLessThan(
      script?.indexOf('Write-Output "ok"') ?? -1,
    );
  });

  it("uses shell -c on POSIX without injecting the PowerShell prefix", () => {
    expect(buildShellInvocation("printf ok", { platform: "linux", shell: "/bin/bash" })).toEqual({
      executable: "/bin/bash",
      args: ["-c", "printf ok"],
    });
  });

  it("falls back to sh when SHELL is unset or empty on POSIX", () => {
    const original = process.env.SHELL;
    try {
      delete process.env.SHELL;
      expect(buildShellInvocation("echo ok", { platform: "linux" })).toEqual({
        executable: "sh",
        args: ["-c", "echo ok"],
      });

      process.env.SHELL = "";
      expect(buildShellInvocation("echo ok", { platform: "linux" })).toEqual({
        executable: "sh",
        args: ["-c", "echo ok"],
      });
    } finally {
      if (original === undefined) delete process.env.SHELL;
      else process.env.SHELL = original;
    }
  });

  it("prefers an explicit shell over the SHELL environment variable", () => {
    const original = process.env.SHELL;
    try {
      process.env.SHELL = "/bin/fish";
      expect(
        buildShellInvocation("echo ok", { platform: "linux", shell: "/bin/zsh" }).executable,
      ).toBe("/bin/zsh");
    } finally {
      if (original === undefined) delete process.env.SHELL;
      else process.env.SHELL = original;
    }
  });
});

describe("shell runtime output", () => {
  it("prefers UTF-8 and falls back to GBK for non-UTF-8 output", () => {
    expect(decodeShellOutput(Buffer.from("中文输出", "utf8"))).toBe("中文输出");
    expect(decodeShellOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb4, 0xed, 0xce, 0xf3]))).toBe(
      "中文错误",
    );
  });

  it("keeps head and tail, reports omitted characters, and does not split Unicode characters", () => {
    const result = truncateShellOutput(`${"开始内容 中文内容 ".repeat(20)}结束内容`, 40);

    expect(result.truncated).toBe(true);
    expect(result.omittedChars).toBeGreaterThan(0);
    expect(result.value).toMatch(/^开始内容/);
    expect(result.value).toMatch(/结束内容$/);
    expect(result.value).toContain("output truncated");
    expect(result.value).not.toContain("\uFFFD");
  });

  it("leaves short output unchanged", () => {
    expect(truncateShellOutput("short", 40)).toEqual({
      value: "short",
      truncated: false,
      omittedChars: 0,
    });
  });

  it("accepts string input for decoding", () => {
    expect(decodeShellOutput("plain text")).toBe("plain text");
  });

  it("hard-cuts output when the budget is smaller than the truncation marker", () => {
    const result = truncateShellOutput("abcdefghij", 3);

    expect(result).toEqual({ value: "abc", truncated: true, omittedChars: 8 });
  });
});

describe("PowerShell error wrapper cleanup", () => {
  it("keeps only the Write-Error message and drops the script echo and CategoryInfo", () => {
    const stderr = [
      "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)",
      'Write-Error "中文错误"',
      "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } : 中文错误",
      "    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException",
      "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException",
      " ",
    ].join("\r\n");

    expect(stripPowerShellErrorWrapper(stderr)).toBe("中文错误");
  });

  it("keeps the Get-Item message and drops its location block and source pointer", () => {
    const stderr = [
      "Get-Item : 找不到路径“D:\\workspace\\missing”，因为该路径不存在。",
      "所在位置 行:1 字符: 269",
      "+ ... terValues['Get-Content:Encoding'] = 'utf8'; Get-Item missing",
      "+                                                 ~~~~~~~~~~~~~~~~~~~~~~~~~",
      "    + CategoryInfo          : ObjectNotFound: (D:\\workspace\\missing:String) [Get-Item], ItemNotFoundException",
      "    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand",
      " ",
    ].join("\r\n");

    expect(stripPowerShellErrorWrapper(stderr)).toBe(
      "Get-Item : 找不到路径“D:\\workspace\\missing”，因为该路径不存在。",
    );
  });

  it("preserves native stderr written before Write-Error", () => {
    const stderr = [
      "npm warn deprecated package",
      "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)",
      'Write-Error "bad"',
      "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } : bad",
      "    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException",
      "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException",
      " ",
    ].join("\r\n");

    expect(stripPowerShellErrorWrapper(stderr)).toBe("npm warn deprecated package\nbad");
  });

  it("keeps every message when a script emits multiple Write-Error records", () => {
    const stderr = [
      'Write-Error "one"; Write-Error "two"',
      "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } : one",
      "    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException",
      "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException",
      " ",
      'Write-Error "one"; Write-Error "two"',
      "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } : two",
      "    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException",
      "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException",
      " ",
    ].join("\r\n");
    const cleaned = stripPowerShellErrorWrapper(stderr);

    expect(cleaned).toContain("one");
    expect(cleaned).toContain("two");
    expect(cleaned).not.toContain("CategoryInfo");
  });

  it("passes native stderr through unchanged when there is no PowerShell wrapper", () => {
    const stderr = "diff --git a/a.txt b/a.txt\n+added\n-removed\n";

    expect(stripPowerShellErrorWrapper(stderr)).toBe(stderr);
  });

  it("keeps parser errors and removes CategoryInfo details", () => {
    const stderr = [
      "表达式缺少右括号。",
      "    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException",
      "    + FullyQualifiedErrorId : MissingEndParenthesisInExpression",
      " ",
    ].join("\r\n");

    expect(stripPowerShellErrorWrapper(stderr)).toBe("表达式缺少右括号。");
  });

  it("cleans an English At line location block", () => {
    const stderr = [
      "Get-Item : Cannot find path 'C:\\missing' because it does not exist.",
      "At line:1 char:269",
      "+ ... [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); Get-Item missing",
      "+                                                                                 ~~~~~~~~~",
      "    + CategoryInfo          : ObjectNotFound: (C:\\missing:String) [Get-Item], ItemNotFoundException",
      "    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand",
      " ",
    ].join("\r\n");

    expect(stripPowerShellErrorWrapper(stderr)).toBe(
      "Get-Item : Cannot find path 'C:\\missing' because it does not exist.",
    );
  });

  it("extracts the Write-Error message even without a CategoryInfo line", () => {
    const stderr = [
      "npm warn deprecated package",
      "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)",
      'Write-Error "bad"',
      "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } : bad",
      " ",
    ].join("\n");

    expect(stripPowerShellErrorWrapper(stderr)).toBe("npm warn deprecated package\nbad");
  });
});
