import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 开发态 .env 加载（仅限 dev，打包版不调用）。
 *
 * Electron main 进程不会读取任何 .env 文件，而 `pnpm dev` 的 cwd 是
 * `apps/desktop`，本地联调需要把云端地址指向仓库根 `.env` 里的环回地址。
 * 这里从 cwd 向上找 `.git` 定位仓库根并加载 `.env`，已有环境变量不覆盖。
 */

export interface DevEnvResult {
  /** 实际读取并生效的 .env 路径；未找到时为 undefined。 */
  path?: string;
  /** 本次真正注入到环境变量的键（不含已存在的）。 */
  appliedKeys: string[];
}

export function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
        if (quote === '"') value = value.replace(/\\n/g, "\n");
      }
    }
    values[key] = value;
  }
  return values;
}

export function findRepoDotEnv(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadDevDotEnv(
  env: Record<string, string | undefined>,
  options: { cwd: string },
): DevEnvResult {
  const path = findRepoDotEnv(options.cwd);
  if (!path) return { appliedKeys: [] };
  const values = parseDotEnv(readFileSync(path, "utf8"));
  const appliedKeys: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    appliedKeys.push(key);
  }
  return { path, appliedKeys };
}
