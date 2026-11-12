import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCliPackaging, CLI_RESOURCE, WINDOWS_CLI_SHIM } from "../scripts/cli-packaging.mjs";

describe("CLI packaging", () => {
  it("adds the CLI bundle and Windows shim to both release profiles", () => {
    const answer = {
      extraResources: [{ from: "resources/vad", to: "vad", filter: ["**/*"] }],
      extraFiles: [],
    };
    applyCliPackaging(answer);
    expect(answer.extraResources).toContainEqual(CLI_RESOURCE);
    expect(answer.extraFiles).toEqual([WINDOWS_CLI_SHIM]);

    const full = { extraResources: [] };
    applyCliPackaging(full);
    expect(full.extraResources).toEqual([CLI_RESOURCE]);
    expect(full.extraFiles).toEqual([WINDOWS_CLI_SHIM]);
  });

  it("keeps the shim pointed at the installed Electron and CLI resource", async () => {
    const shim = await readFile(resolve("resources/cli/answra.cmd"), "utf8");
    expect(shim).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(shim).toContain('"%~dp0Answra.exe"');
    expect(shim).toContain('"%~dp0resources\\cli\\main.cjs"');
  });
});
