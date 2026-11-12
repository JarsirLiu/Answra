import { describe, expect, it } from "vitest";
import { CliUsageError } from "../src/cli/errors";
import { parseCliOptions } from "../src/config/cliOptions";

function expectUsageError(argv: string[], message: string): void {
  expect(() => parseCliOptions(argv)).toThrowError(CliUsageError);
  expect(() => parseCliOptions(argv)).toThrowError(message);
}

describe("parseCliOptions", () => {
  it("returns help for empty argv", () => {
    expect(parseCliOptions([])).toEqual({ kind: "help" });
  });

  it("parses a bare code command", () => {
    expect(parseCliOptions(["code"])).toEqual({ kind: "code" });
  });

  it("parses options in separate and inline forms", () => {
    expect(
      parseCliOptions([
        "code",
        "--cwd=ws",
        "--base-url",
        "http://127.0.0.1:1234/v1",
        "--model",
        "local-model",
        "--api-key=secret",
        "write tests",
      ]),
    ).toEqual({
      kind: "code",
      cwd: "ws",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      apiKey: "secret",
      prompt: "write tests",
    });
  });

  it("treats tokens after -- as positional prompt text", () => {
    expect(parseCliOptions(["code", "--", "--not-an-option"])).toEqual({
      kind: "code",
      prompt: "--not-an-option",
    });
  });

  it("gives help and version priority over a command", () => {
    expect(parseCliOptions(["code", "--help"])).toEqual({ kind: "help" });
    expect(parseCliOptions(["code", "-v"])).toEqual({ kind: "version" });
  });

  it("rejects unknown commands", () => {
    expectUsageError(["other"], "未知命令：other");
  });

  it("rejects unknown options before reading their value", () => {
    expectUsageError(["code", "--bad"], "未知选项：--bad");
    expectUsageError(["code", "--bad=value"], "未知选项：--bad");
  });

  it("rejects missing option values", () => {
    expectUsageError(["code", "--model"], "选项 --model 缺少值。");
    expectUsageError(["code", "--model="], "选项 --model 缺少值。");
    expectUsageError(["code", "--model", "--cwd", "ws"], "选项 --model 缺少值。");
  });

  it("rejects more than one prompt", () => {
    expectUsageError(["code", "one", "two"], "只接受一个 prompt 位置参数。");
  });
});
