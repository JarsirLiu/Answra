import { describe, expect, it } from "vitest";
import {
  applyUserShellEnv,
  loadUserShellEnv,
  parseShellEnv,
  resolveUserShell,
  type ShellEnvProbeOptions,
  type ShellEnvProbeResult,
  type ShellEnvSpawn,
} from "../src/main/userShellEnv";

function envOutput(variables: Record<string, string>): Buffer {
  return Buffer.from(
    `${Object.entries(variables)
      .map(([key, value]) => `${key}=${value}`)
      .join("\0")}\0`,
    "utf8",
  );
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ShellEnvProbeOptions;
}

function fakeSpawn(handler: (mode: string) => ShellEnvProbeResult): {
  spawn: ShellEnvSpawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return handler(args[0] ?? "");
    },
  };
}

describe("resolveUserShell", () => {
  it("prefers the SHELL environment value", () => {
    expect(resolveUserShell("/bin/bash", "/bin/zsh")).toBe("/bin/bash");
  });

  it("falls back to the login shell and then to /bin/sh", () => {
    expect(resolveUserShell(undefined, "/bin/zsh")).toBe("/bin/zsh");
    expect(resolveUserShell("", null)).toBe("/bin/sh");
  });
});

describe("parseShellEnv", () => {
  it("splits NUL entries and preserves '=' inside values", () => {
    expect(parseShellEnv(envOutput({ PATH: "/opt/homebrew/bin:/usr/bin", FLAGS: "a=b" }))).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      FLAGS: "a=b",
    });
  });

  it("ignores empty, keyless and malformed entries", () => {
    expect(parseShellEnv(Buffer.from("\0=novalue\0nokey\0OK=1\0", "utf8"))).toEqual({ OK: "1" });
  });
});

describe("loadUserShellEnv", () => {
  it("skips Windows without probing", () => {
    const result = loadUserShellEnv({ platform: "win32" });
    expect(result).toEqual({ status: "skipped", reason: "windows" });
  });

  it("skips nushell without probing", () => {
    const { spawn, calls } = fakeSpawn(() => {
      throw new Error("must not probe");
    });
    expect(
      loadUserShellEnv({ platform: "darwin", envShell: "/opt/homebrew/bin/nu", spawn }),
    ).toEqual({ status: "skipped", reason: "nushell" });
    expect(calls).toHaveLength(0);
  });

  it("loads the interactive shell environment first", () => {
    const { spawn, calls } = fakeSpawn(() => ({
      status: 0,
      stdout: envOutput({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/answra" }),
    }));
    expect(
      loadUserShellEnv({ platform: "darwin", envShell: "/bin/zsh", loginShell: null, spawn }),
    ).toEqual({
      status: "loaded",
      shell: "/bin/zsh",
      source: "interactive",
      variables: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/answra" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["-il", "-c", "env -0"]);
    expect(calls[0]?.options).toEqual({ timeout: 5_000, windowsHide: true });
  });

  it("does not retry a timed-out interactive probe", () => {
    const { spawn, calls } = fakeSpawn(() => ({ status: null, error: { code: "ETIMEDOUT" } }));
    expect(
      loadUserShellEnv({ platform: "darwin", envShell: "/bin/zsh", loginShell: null, spawn }),
    ).toEqual({ status: "skipped", reason: "probe-timeout" });
    expect(calls).toHaveLength(1);
  });

  it("falls back to the login shell when the interactive probe fails", () => {
    const { spawn, calls } = fakeSpawn((mode) =>
      mode === "-il"
        ? { status: 1 }
        : { status: 0, stdout: envOutput({ PATH: "/opt/homebrew/bin" }) },
    );
    expect(
      loadUserShellEnv({ platform: "darwin", envShell: "/bin/zsh", loginShell: null, spawn }),
    ).toEqual({
      status: "loaded",
      shell: "/bin/zsh",
      source: "login",
      variables: { PATH: "/opt/homebrew/bin" },
    });
    expect(calls.map((call) => call.args[0])).toEqual(["-il", "-l"]);
  });

  it("reports unavailable when both probes fail or return no variables", () => {
    const failing = fakeSpawn((mode) =>
      mode === "-il" ? { status: 1 } : { status: 0, stdout: Buffer.from("\0") },
    );
    expect(
      loadUserShellEnv({
        platform: "darwin",
        envShell: "/bin/zsh",
        loginShell: null,
        spawn: failing.spawn,
      }),
    ).toEqual({ status: "skipped", reason: "unavailable" });

    const empty = fakeSpawn(() => ({ status: 0, stdout: envOutput({}) }));
    expect(
      loadUserShellEnv({
        platform: "darwin",
        envShell: "/bin/zsh",
        loginShell: null,
        spawn: empty.spawn,
      }),
    ).toEqual({ status: "skipped", reason: "unavailable" });
  });
});

describe("applyUserShellEnv", () => {
  it("merges probed variables into the target env", () => {
    const { spawn } = fakeSpawn(() => ({
      status: 0,
      stdout: envOutput({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/answra" }),
    }));
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", ANSWRA_FEATURE: "1" };
    const result = applyUserShellEnv(env, {
      platform: "darwin",
      envShell: "/bin/zsh",
      loginShell: null,
      spawn,
    });
    expect(result.status).toBe("loaded");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.HOME).toBe("/Users/answra");
    expect(env.ANSWRA_FEATURE).toBe("1");
  });

  it("leaves the env untouched on Windows", () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32" };
    expect(applyUserShellEnv(env, { platform: "win32" })).toEqual({
      status: "skipped",
      reason: "windows",
    });
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });
});
