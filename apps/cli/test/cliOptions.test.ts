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

  it("parses --no-alt-screen as a valueless flag", () => {
    expect(parseCliOptions(["code", "--no-alt-screen"])).toEqual({
      kind: "code",
      altScreen: false,
    });
    expectUsageError(["code", "--no-alt-screen=true"], "--no-alt-screen 不接受值。");
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

  it("parses config show and unset", () => {
    expect(parseCliOptions(["config", "show"])).toEqual({ kind: "config", action: "show" });
    expect(parseCliOptions(["config", "unset"])).toEqual({ kind: "config", action: "unset" });
  });

  it("parses config set options in separate and inline forms", () => {
    expect(
      parseCliOptions([
        "config",
        "set",
        "--base-url=http://127.0.0.1:1234/v1",
        "--model",
        "qwen",
        "--answer-model",
        "qwen-vl",
        "--api-key",
        "sk-config",
      ]),
    ).toEqual({
      kind: "config",
      action: "set",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen",
      answerModel: "qwen-vl",
      apiKey: "sk-config",
    });
  });

  it("rejects invalid config commands and options", () => {
    expectUsageError(["config"], "缺少 config 子命令（show|set|unset）。");
    expectUsageError(["config", "other"], "未知 config 子命令：other");
    expectUsageError(["config", "show", "extra"], "config show 不接受参数。");
    expectUsageError(
      ["config", "set", "--model", "qwen"],
      "config set 需要 --base-url 和 --model。",
    );
    expectUsageError(
      ["config", "set", "--base-url", "http://127.0.0.1:1234/v1", "--model", "qwen", "extra"],
      "config set 不接受位置参数：extra",
    );
    expectUsageError(
      ["config", "set", "--base-url", "http://127.0.0.1:1234/v1", "--model", "qwen", "--bad"],
      "未知选项：--bad",
    );
  });

  it("gives help priority inside config commands", () => {
    expect(parseCliOptions(["config", "set", "--help"])).toEqual({ kind: "help" });
  });

  it("parses remote key commands", () => {
    expect(
      parseCliOptions(["remote", "key", "create", "--days", "7", "--label", "office"]),
    ).toEqual({ kind: "remote", action: "key-create", days: 7, label: "office" });
    expect(parseCliOptions(["remote", "key", "create"])).toEqual({
      kind: "remote",
      action: "key-create",
    });
    expect(parseCliOptions(["remote", "key", "list"])).toEqual({
      kind: "remote",
      action: "key-list",
    });
    expect(parseCliOptions(["remote", "key", "revoke", "abc"])).toEqual({
      kind: "remote",
      action: "key-revoke",
      keyId: "abc",
    });
    expect(parseCliOptions(["remote", "key", "set"])).toEqual({
      kind: "remote",
      action: "key-set",
    });
    expect(parseCliOptions(["remote", "key", "show"])).toEqual({
      kind: "remote",
      action: "key-show",
    });
    expect(parseCliOptions(["remote", "key", "forget"])).toEqual({
      kind: "remote",
      action: "key-forget",
    });
    expect(parseCliOptions(["remote", "--help"])).toEqual({
      kind: "remote",
      action: "help",
    });
  });

  it("rejects invalid remote key commands", () => {
    expect(() => parseCliOptions(["remote"])).toThrowError(CliUsageError);
    expect(() => parseCliOptions(["remote", "other"])).toThrowError(CliUsageError);
    expect(() => parseCliOptions(["remote", "key"])).toThrowError(CliUsageError);
    expect(() => parseCliOptions(["remote", "key", "other"])).toThrowError(CliUsageError);
    expect(() => parseCliOptions(["remote", "key", "list", "extra"])).toThrowError(CliUsageError);
    expect(() => parseCliOptions(["remote", "key", "revoke"])).toThrowError(CliUsageError);
    expect(() => parseCliOptions(["remote", "key", "create", "--days", "x"])).toThrowError(
      CliUsageError,
    );
    expect(() => parseCliOptions(["remote", "key", "create", "--bad"])).toThrowError(CliUsageError);
  });
});
