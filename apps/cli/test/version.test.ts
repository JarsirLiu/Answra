import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../src/version";

describe("CLI version", () => {
  it("matches package.json", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(CLI_VERSION).toBe(manifest.version);
  });
});
