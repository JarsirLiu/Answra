import { describe, expect, it } from "vitest";
import {
  buildWindowsJobBootstrap,
  JOB_MARKER_ENV,
  parseJobContainmentMarker,
} from "../../../../src/core/tool/builtin/shell/processTree";

describe("shell process tree", () => {
  it("parses Job containment marker values", () => {
    expect(parseJobContainmentMarker("True")).toBe("ok");
    expect(parseJobContainmentMarker("True\r\n")).toBe("ok");
    expect(parseJobContainmentMarker("False")).toBe("failed");
    expect(parseJobContainmentMarker("false")).toBe("failed");
    expect(parseJobContainmentMarker("")).toBe("unknown");
    expect(parseJobContainmentMarker("garbage")).toBe("unknown");
  });

  it("embeds the Windows Job Object flags and reports containment through the marker", () => {
    const bootstrap = buildWindowsJobBootstrap();
    expect(bootstrap).toContain(`$env:${JOB_MARKER_ENV}`);
    expect(bootstrap).toContain("Set-Content");

    const base64 = bootstrap.match(/FromBase64String\('([^']+)'\)/)?.[1];
    if (!base64) throw new Error("Job bootstrap is missing its embedded C# source");
    const source = Buffer.from(base64, "base64").toString("utf8");
    expect(source).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(source).toContain("JOB_OBJECT_LIMIT_BREAKAWAY_OK");
    expect(source).toContain("AssignProcessToJobObject");
    expect(source).toContain("SetInformationJobObject");
  });
});
