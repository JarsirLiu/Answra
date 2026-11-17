import { describe, expect, it } from "vitest";
import { createProcessContainment } from "../../../../src/core/tool/builtin/runCommand/process/containment";
import { JOB_MARKER_ENV } from "../../../../src/core/tool/builtin/runCommand/process/windows";

describe("shell process containment", () => {
  it("selects Job Object containment on Windows", () => {
    const containment = createProcessContainment("win32");
    const options = containment.spawnOptions();

    expect(containment.kind).toBe("job-object");
    expect(containment.shellBootstrap).toContain("Add-Type");
    expect(options.detached).toBe(false);
    expect(options.env?.[JOB_MARKER_ENV]).toBe(containment.jobMarkerPath);
  });

  it("selects process-group containment on POSIX", () => {
    const containment = createProcessContainment("linux");
    const options = containment.spawnOptions();

    expect(containment.kind).toBe("process-group");
    expect(containment.shellBootstrap).toBeUndefined();
    expect(containment.jobMarkerPath).toBeUndefined();
    expect(options.detached).toBe(true);
  });
});
