import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoDotEnv, loadDevDotEnv, parseDotEnv } from "../src/main/devEnv";

/** 开发态 .env 加载：解析规则、向上定位仓库根、不覆盖已有环境变量。 */
describe("parseDotEnv", () => {
  it("parses key=value lines and ignores comments/blank/invalid lines", () => {
    expect(
      parseDotEnv(
        [
          "# comment",
          "",
          "ANSWRA_CLOUD_API_BASE_URL=http://127.0.0.1:8080",
          "  ANSWRA_CLOUD_SITE_BASE_URL = http://127.0.0.1:3100  ",
          'QUOTED="hello world"',
          "SINGLE='v'",
          'ESCAPED="a\\nb"',
          "=novalue",
          "INVALID KEY=x",
          "noline",
        ].join("\n"),
      ),
    ).toEqual({
      ANSWRA_CLOUD_API_BASE_URL: "http://127.0.0.1:8080",
      ANSWRA_CLOUD_SITE_BASE_URL: "http://127.0.0.1:3100",
      QUOTED: "hello world",
      SINGLE: "v",
      ESCAPED: "a\nb",
    });
  });

  it("handles CRLF content", () => {
    expect(parseDotEnv("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("findRepoDotEnv", () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "answra-devenv-"));
    mkdirSync(join(root, "apps", "desktop"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
  }

  it("walks up to the repo root .env", () => {
    const root = makeRepo();
    const envPath = join(root, ".env");
    writeFileSync(envPath, "A=1\n");
    expect(findRepoDotEnv(join(root, "apps", "desktop"))).toBe(envPath);
  });

  it("stops at the repo root without a .env file", () => {
    const root = makeRepo();
    expect(findRepoDotEnv(join(root, "apps", "desktop"))).toBeUndefined();
  });

  it("gives up outside a repository", () => {
    const bare = mkdtempSync(join(tmpdir(), "answra-devenv-bare-"));
    try {
      expect(findRepoDotEnv(bare)).toBeUndefined();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("loadDevDotEnv", () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "answra-devenv-load-"));
    mkdirSync(join(root, "apps", "desktop"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
  }

  it("injects missing vars and never overrides existing ones", () => {
    const root = makeRepo();
    writeFileSync(join(root, ".env"), "ANSWRA_A=from-file\nANSWRA_B=from-file\n");
    const env: Record<string, string | undefined> = { ANSWRA_A: "already-set" };
    const result = loadDevDotEnv(env, { cwd: join(root, "apps", "desktop") });
    expect(result.appliedKeys).toEqual(["ANSWRA_B"]);
    expect(env.ANSWRA_A).toBe("already-set");
    expect(env.ANSWRA_B).toBe("from-file");
  });

  it("is a no-op without a .env file", () => {
    const env: Record<string, string | undefined> = {};
    const result = loadDevDotEnv(env, { cwd: makeRepo() });
    expect(result.appliedKeys).toEqual([]);
  });
});
