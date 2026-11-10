import { describe, expect, it } from "vitest";
import {
  buildEnvironmentSystemContext,
  type RuntimeEnvironment,
} from "../../../src/conversation/turn/environmentContext";

const WINDOWS_ENVIRONMENT: RuntimeEnvironment = {
  platform: "win32",
  release: "10.0.22631",
  arch: "x64",
  shell: {
    executable: "powershell.exe",
    displayName: "Windows PowerShell 5.1 (powershell.exe)",
    syntax: "powershell",
  },
};

describe("runtime environment system context", () => {
  it("reports Windows and PowerShell syntax without narrating tool capabilities", () => {
    const context = buildEnvironmentSystemContext(WINDOWS_ENVIRONMENT);

    expect(context).toContain("# 运行环境");
    expect(context).toContain("操作系统：Windows（win32 10.0.22631 x64）");
    expect(context).toContain("Shell：Windows PowerShell 5.1 (powershell.exe)");
    expect(context).toContain("不要使用 bash/sh 专有语法");
    expect(context).not.toMatch(/\b(Read|Grep|RunCommand)\b/);
  });

  it("reports the configured POSIX shell and syntax", () => {
    const context = buildEnvironmentSystemContext({
      platform: "linux",
      release: "6.8.0",
      arch: "arm64",
      shell: { executable: "/bin/bash", displayName: "/bin/bash", syntax: "posix" },
    });

    expect(context).toContain("操作系统：Linux（linux 6.8.0 arm64）");
    expect(context).toContain("Shell：/bin/bash");
    expect(context).toContain("使用 POSIX shell 语法");
  });

  it("uses the raw platform identifier for platforms without a friendly label", () => {
    const context = buildEnvironmentSystemContext({
      platform: "freebsd",
      release: "14.0",
      arch: "x64",
      shell: { executable: "/bin/sh", displayName: "/bin/sh", syntax: "posix" },
    });

    expect(context).toContain("操作系统：freebsd（freebsd 14.0 x64）");
  });
});
