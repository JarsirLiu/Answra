import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ImeInputMode, ImeKeyRequest, ImeState } from "@answra/shared";
import { app } from "electron";
import { rimeKeyCode, rimeKeyMask } from "./rimeKeyMapping";

const EMPTY: ImeState = {
  enabled: false,
  inputMode: "chinese",
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

type Pending = { resolve: (state: ImeState) => void; reject: (error: Error) => void };

function runtimePaths():
  | {
      helper: string;
      library: string;
      shared: string;
      user: string;
      cwd: string;
      projectData: string;
    }
  | undefined {
  const platform =
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : undefined;
  if (!platform) return undefined;
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
  const cwd = join(root, "rime", platform);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const helper = join(cwd, `answra-rime-host${suffix}`);
  const library =
    process.platform === "win32" ? join(cwd, "librime.dll") : join(cwd, "lib", "librime.dylib");
  if (!existsSync(helper) || !existsSync(library)) return undefined;
  return {
    helper,
    library,
    shared: join(root, "rime", "shared"),
    user: join(app.getPath("userData"), "rime"),
    cwd,
    projectData: app.isPackaged
      ? join(root, "rime", "shared")
      : join(app.getAppPath(), "native", "rime-data"),
  };
}

export class RimeBridge {
  private child?: ChildProcessWithoutNullStreams;
  private state: ImeState = EMPTY;
  private startup?: Promise<void>;
  private availableValue = false;
  private helperProtocolVersion = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor() {
    this.startup = this.start();
  }

  get available(): boolean {
    return this.availableValue && this.helperProtocolVersion === 2;
  }

  get snapshot(): ImeState {
    return this.state;
  }

  async enable(enabled: boolean): Promise<ImeState> {
    await this.startup;
    if (!this.available) return { ...EMPTY, handled: false };
    return this.command("enable", enabled ? "1" : "0");
  }

  async key(request: ImeKeyRequest): Promise<ImeState> {
    await this.startup;
    if (!this.available || !this.state.enabled) {
      console.warn("[ime] key rejected", {
        available: this.available,
        enabled: this.state.enabled,
        key: request.key,
      });
      return { ...this.state, handled: false };
    }
    const keycode = rimeKeyCode(request);
    if (keycode === undefined) return { ...this.state, handled: false };
    const mask = rimeKeyMask(request);
    const state = await this.command("key", String(keycode), String(mask));
    if (!state.handled && !state.composing)
      console.info("[ime] key unhandled", { key: request.key, code: request.code });
    return state;
  }

  async select(index: number): Promise<ImeState> {
    await this.startup;
    if (!this.available || !Number.isInteger(index) || index < 0)
      return { ...this.state, handled: false };
    return this.command("select", String(index));
  }

  async reset(): Promise<ImeState> {
    await this.startup;
    if (!this.available) return { ...EMPTY, handled: false };
    return this.command("reset");
  }

  async setInputMode(inputMode: ImeInputMode): Promise<ImeState> {
    await this.startup;
    if (!this.available || !this.state.enabled) return { ...this.state, handled: false };
    return this.command("set-mode", inputMode === "ascii" ? "1" : "0");
  }

  dispose(): void {
    this.child?.stdin.write(`${this.nextId++}\tquit\n`);
    this.child?.stdin.end();
    this.child = undefined;
    for (const entry of this.pending.values()) entry.reject(new Error("Rime helper stopped"));
    this.pending.clear();
  }

  private async start(): Promise<void> {
    const paths = runtimePaths();
    if (!paths) {
      const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
      const platform =
        process.platform === "win32"
          ? "win32"
          : process.platform === "darwin"
            ? "darwin"
            : "unsupported";
      console.warn("[ime] native Rime helper or librime runtime is missing", {
        helper: join(
          root,
          "rime",
          platform,
          `answra-rime-host${process.platform === "win32" ? ".exe" : ""}`,
        ),
        library: join(
          root,
          "rime",
          platform,
          process.platform === "win32" ? "librime.dll" : join("lib", "librime.dylib"),
        ),
        hint: "run pnpm --filter @answra/desktop ime:prepare",
      });
      return;
    }
    try {
      await mkdir(paths.shared, { recursive: true });
      for (const file of ["luna_pinyin_simp.custom.yaml"]) {
        await copyFile(join(paths.projectData, file), join(paths.shared, file));
      }
      await mkdir(paths.user, { recursive: true });
      const schemaPatch = join(paths.user, "luna_pinyin_simp.custom.yaml");
      let migrateLegacyPatch = false;
      if (existsSync(schemaPatch)) {
        const existing = await readFile(schemaPatch, "utf8");
        migrateLegacyPatch =
          existing.includes("translator/dictionary: answra") ||
          existing.includes("translator/dictionary: luna_pinyin") ||
          existing.includes("ascii_composer/switch_key/Shift_L") ||
          existing.includes("ascii_composer/switch_key/Shift_R");
      }
      if (!existsSync(schemaPatch) || migrateLegacyPatch) {
        await copyFile(join(paths.shared, "luna_pinyin_simp.custom.yaml"), schemaPatch);
      }
      const child = spawn(
        paths.helper,
        [paths.library, paths.shared, paths.user, "luna_pinyin_simp"],
        {
          cwd: paths.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      this.child = child;
      child.stderr.on("data", (chunk: Buffer) =>
        console.warn("[ime][native]", chunk.toString().trimEnd()),
      );
      child.on("error", (error) => this.fail(error));
      child.on("exit", (code, signal) => {
        if (this.child !== child) return;
        this.availableValue = false;
        this.state = EMPTY;
        this.fail(new Error(`Rime helper exited (code=${code}, signal=${signal})`));
      });
      const lines = createInterface({ input: child.stdout });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Rime helper startup timed out")), 15000);
        lines.once("line", (line) => {
          clearTimeout(timeout);
          try {
            const [id, payload] = line.split("\t", 2);
            const result = JSON.parse(payload ?? "{}") as {
              available?: boolean;
              protocolVersion?: number;
            };
            if (id !== "0" || result.available !== true || result.protocolVersion !== 2)
              throw new Error("librime helper protocol v2 is required");
            this.helperProtocolVersion = result.protocolVersion;
            this.availableValue = true;
            lines.on("line", (message) => this.receive(message));
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      console.info("[ime] native librime helper ready");
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      console.warn("[ime] librime unavailable", error);
    }
  }

  private command(...fields: string[]): Promise<ImeState> {
    const child = this.child;
    if (!child || !this.available) return Promise.resolve({ ...EMPTY, handled: false });
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${id}\t${fields.join("\t")}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private receive(line: string): void {
    const [rawId, payload] = line.split("\t", 2);
    const id = Number(rawId);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    try {
      const state = JSON.parse(payload ?? "") as ImeState;
      this.state = state;
      pending.resolve(state);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    this.availableValue = false;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}
