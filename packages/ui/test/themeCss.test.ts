import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 主题 CSS 完整性守卫：下面两类写法失效时都不会报错，
 * 只会静默地把文字/表面变回浅色主题值（深色下即不可见）。
 */

const sourceRoot = resolve(process.cwd(), "src");

/** 由 JS 在运行时写入的令牌；调用方给值的可选项带自身回退，CSS 里没有声明。 */
const runtimeProvidedTokens = new Set([
  "--cue-x",
  "--cue-y",
  "--cue-w",
  "--slider-fill",
  "--ime-input-text-color",
]);

function collectFiles(directory: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...collectFiles(path, extension));
    else if (entry.endsWith(extension)) files.push(path);
  }
  return files;
}

function matches(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] as string);
}

/** 断言只针对生效的 CSS：注释里可以自由讨论这些失效写法。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("theme CSS integrity", () => {
  const cssFiles = collectFiles(sourceRoot, ".css");
  const scriptFiles = [...collectFiles(sourceRoot, ".ts"), ...collectFiles(sourceRoot, ".tsx")];

  it("declares theme variables with :global(...), never ::global(...)", () => {
    // lightningcss（Vite 的 CSS modules 处理器）不识别双冒号写法，
    // 会把整条规则原样输出成无效选择器：--tr-* 等主题变量全体失效。
    const offenders = cssFiles.filter((file) =>
      stripComments(readFileSync(file, "utf8")).includes("::global("),
    );
    expect(offenders).toEqual([]);
  });

  it("only references tokens declared in CSS or written at runtime", () => {
    const cssText = cssFiles.map((file) => stripComments(readFileSync(file, "utf8"))).join("\n");
    const scriptText = scriptFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    const declared = new Set([
      ...matches(/(--[a-z0-9-]+)\s*:/g, cssText),
      ...matches(/(--[a-z0-9-]+)\s*:/g, scriptText),
      ...matches(/setProperty\(\s*"(--[a-z0-9-]+)"/g, scriptText),
      ...matches(/\["(--[a-z0-9-]+)"/g, scriptText),
      ...runtimeProvidedTokens,
    ]);
    // 未声明的令牌会让整条声明无效：表面回退透明、文字回退 UA 默认色。
    const unknown = [...new Set(matches(/var\((--[a-z0-9-]+)/g, cssText))]
      .filter((token) => !declared.has(token))
      .sort();
    expect(unknown).toEqual([]);
  });
});
