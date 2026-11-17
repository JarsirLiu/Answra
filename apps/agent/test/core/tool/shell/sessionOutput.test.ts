import { describe, expect, it } from "vitest";
import {
  type SessionOutputState,
  snapshotSession,
} from "../../../../src/core/tool/builtin/runCommand/process/sessionOutput";

const POWERSHELL_PREFIX = "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)";

function createSession(stderrText: readonly string[]): SessionOutputState {
  return {
    shellSyntax: "powershell",
    stdoutText: [],
    stderrText,
    stdoutEmittedChars: 0,
    stderrEmittedChars: 0,
    outputTruncated: false,
    outputOmittedBytes: 0,
    exitCode: undefined,
    signal: undefined,
  };
}

describe("session output snapshots", () => {
  it("holds an incomplete PowerShell error wrapper until it can be cleaned", () => {
    const stderrText = [POWERSHELL_PREFIX];
    let session = createSession(stderrText);

    expect(snapshotSession("session-1", session).stderr).toBe("");
    expect(session.stderrEmittedChars).toBe(0);

    stderrText.push(
      [
        "",
        'Write-Error "中文错误"',
        "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } : 中文错误",
        "    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException",
        "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException",
        " ",
      ].join("\r\n"),
    );
    session = { ...session, exitCode: 0 };

    const finished = snapshotSession("session-1", session);
    expect(finished.stderr).toContain("中文错误");
    expect(finished.stderr).not.toContain("[Console]::");
  });
});
