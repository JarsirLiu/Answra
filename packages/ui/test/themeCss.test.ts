import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 主题 CSS 完整性守卫：下面几类写法失效时都不会报错，
 * 只会静默地把文字/表面变回浅色主题值（深色下即不可见），或让隐身模式露指针形状。
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

  it("keeps the switch thumb off the ambient surface tokens", () => {
    // 变色龙会替换 --paper-tint、把 --shadow-ctl-* 归零；关闭态拇指若取表面色，
    // 就会在浅色轨道里变成一颗背景色圆点。拇指属于控件而非表面，必须取控件实色
    // （--icon），并在开启态才切回反色前景（--on-ink）。
    const css = stripComments(
      readFileSync(join(sourceRoot, "components", "controls", "Switch.css"), "utf8"),
    );
    const base = css.match(/\.switch-thumb\s*\{([^}]*)\}/)?.[1] ?? "";
    const on = css.match(/\.switch\.is-on\s+\.switch-thumb\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(base).toContain("var(--icon)");
    expect(base).not.toContain("var(--paper)");
    expect(on).toContain("var(--on-ink)");
  });

  it("keeps surfaces opaque and gives inverse foreground its own token", () => {
    const css = stripComments(readFileSync(join(sourceRoot, "styles", "tokens.css"), "utf8"));
    const paper = css.match(/--paper:\s*([^;]+);/)?.[1] ?? "";
    const onInk = css.match(/--on-ink:\s*([^;]+);/)?.[1] ?? "";
    expect(css).toContain("--paper-base: 1;");
    expect(paper).toContain("var(--paper-base)");
    expect(paper).not.toContain("--fade");
    // 反色前景仍受透明度控制；否则纸面文字在低透明度下反而不变。
    expect(onInk).toContain("--fade");
    expect(css).toContain("--warning:");
    expect(css).toContain("--warning-wash:");
    expect(css).toContain("--success:");
    expect(css).toContain("--success-wash:");
  });

  it("keeps panel status colors on semantic tokens", () => {
    for (const file of ["AnnouncementList.css", "SettingsPanel.css"]) {
      const css = stripComments(
        readFileSync(join(sourceRoot, "components", "panels", file), "utf8"),
      );
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\(/i);
    }
    const announcements = stripComments(
      readFileSync(join(sourceRoot, "components", "panels", "AnnouncementList.css"), "utf8"),
    );
    expect(announcements).toContain("var(--danger-wash)");
    expect(announcements).toContain("var(--warning)");
    expect(announcements).toContain("var(--warning-wash)");
    const settings = stripComments(
      readFileSync(join(sourceRoot, "components", "panels", "SettingsPanel.css"), "utf8"),
    );
    expect(settings).toContain("var(--danger)");
    expect(settings).toContain("var(--success)");
  });

  it("keeps the reply bar and its details panel on palette tokens, without hardcoded colors", () => {
    // 写死的色值绕过 [data-theme] 与变色龙：主题切换或跟随背景时这些文字/图标不会
    // 跟着变（浅色主题下配深底、深色主题下配近黑），跑马灯的活动色尤其明显。
    // 发送条/回复条与展开详情里的颜色必须走调色板令牌。
    for (const file of ["ReplyBar.css", "ReplyConversationPopover.css"]) {
      const css = stripComments(
        readFileSync(join(sourceRoot, "components", "panels", file), "utf8"),
      );
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\(/i);
    }
  });

  it("keeps chat content parts on palette tokens, without hardcoded colors", () => {
    // 对话区（思考 / 正文 / 工具调用 / 操作条 / 消息流）必须与外壳共用一套令牌：
    // 写死色值会绕过 [data-theme] 与变色龙，深浅色下固定配色会与面板分叉。
    for (const file of [
      "AssistantMessage.module.css",
      "MessageActions.module.css",
      "MessageStream.module.css",
      "ModelErrorNotice.module.css",
      "TextResponse.module.css",
      "ThinkingReasoning.module.css",
      "ToolResponse.module.css",
      "conversation.css",
    ]) {
      const css = stripComments(readFileSync(join(sourceRoot, "components", "chat", file), "utf8"));
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\(/i);
    }
  });

  it("keeps the stealth cursor override strong enough to beat component cursor rules", () => {
    // 隐身模式下指针必须恒为默认箭头，否则指针形状会暴露正在输入/选择。
    // 组件里的 cursor 规则会追平覆盖规则的 (0,2,0)（如 `.trHeader.isClickable`），
    // 同特异性由源顺序决定；`.x button:hover:not(:disabled)` 更是 (0,3,1)。
    // 因此覆盖必须带 !important，去掉后这些元素在隐身模式下会重新露出非默认指针。
    const base = stripComments(readFileSync(join(sourceRoot, "styles", "base.css"), "utf8"));
    expect(base).toContain('html[data-stealth="true"] *');
    expect(base).toContain('.overlay-root[data-stealth="true"] *');
    expect(base).toContain('.reply-window-root[data-stealth="true"] *');
    expect(base).toMatch(/html\[data-stealth="true"\][^{}]*\{[^}]*cursor:\s*default\s*!important/);
  });

  it("keeps panel chrome typography on the token scale, without px literals", () => {
    // 面板骨架（标题/Tab/设置行）的字号只允许走 tokens.css 的四档令牌：
    // px 字面量会绕过字号令牌（历史上正是面板标题硬编码 12px 绕开了令牌管制）。
    // 对话等内容文件保留自己的内容字号尺度，不在本守卫范围。
    for (const file of [
      "PanelShell.css",
      "SettingsPanel.css",
      "AccountPanel.css",
      "AnnouncementList.css",
    ]) {
      const css = stripComments(
        readFileSync(join(sourceRoot, "components", "panels", file), "utf8"),
      );
      expect(css, file).not.toMatch(/font-size:\s*[\d.]+px/);
    }
  });
});
