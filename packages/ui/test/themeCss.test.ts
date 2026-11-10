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

  it("keeps surface shadows at none", () => {
    // 透明窗口四周只有 4/8px 的透明余量，任何 blur/offset 都会被窗口边界
    // 裁成贴边灰环（实测「应用外有一层」的来源）；悬浮条也不用阴影装悬浮感。
    // 要恢复投影必须先对照 2026-10-31 bug-fix Note 的余量约束与用户裁定。
    const css = readFileSync(join(sourceRoot, "styles", "tokens.css"), "utf8");
    expect(css).toMatch(/--shadow-bar:\s*none;/);
    expect(css).toMatch(/--shadow-pop:\s*none;/);
  });

  it("keeps every panel width on the floating bar measurement", () => {
    // 面板与胶囊恒为同宽：所有变体统一继承基类 --surface-w 宽度，
    // 不允许出现第二套 px 宽度来源（曾导致 480px 面板 × 307px 胶囊的错位）。
    // 视口不得反过来约束变体宽度；基类 100vw 上限只会被 surface-w 地板盖过。
    const css = stripComments(
      readFileSync(join(sourceRoot, "components", "panels", "PanelShell.css"), "utf8"),
    );
    const base = css.match(/\.content-panel\s*\{([^}]*)\}/)?.[1];
    expect(base).toBeDefined();
    expect(base).toContain("min(var(--surface-w");
    const fixedVariants = css.match(
      /\.content-panel--notes,\s*\.content-panel--settings,\s*\.content-panel--interview\s*\{([^}]*)\}/,
    )?.[1];
    const account = css.match(/\.content-panel--account\s*\{([^}]*)\}/)?.[1];
    for (const body of [fixedVariants, account]) {
      expect(body).toBeDefined();
      expect(body).not.toMatch(/width\s*:/);
      expect(body).not.toContain("100vw");
    }
  });

  it("keeps announcement views inside the fixed panel, scrolled not stretched", () => {
    // 定高面板（560px 上限）必须由列表/详情自身滚动，任何一条根容器
    // 失去 min-height:0 / overflow-y 都会让窗口随公告内容无限变高。
    const css = stripComments(
      readFileSync(join(sourceRoot, "components", "panels", "AnnouncementList.css"), "utf8"),
    );
    const ruleOf = (selector: string) => {
      const start = css.indexOf(selector);
      if (start === -1) return "";
      return css.slice(start, css.indexOf("}", start));
    };
    for (const selector of [".announcement-view", ".announcement-detail"]) {
      expect(ruleOf(selector), selector).toContain("min-height: 0");
    }
    for (const selector of [".announcement-list", ".announcement-detail"]) {
      expect(ruleOf(selector), selector).toContain("overflow-y: auto");
    }
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
    // 未读红点与详情页错误提示都从 --danger 家族取色；这是守卫意图，
    // 不是具体版式断言（见 2026-10-31 公告两级导航 Note）。
    expect(announcements).toContain("var(--danger)");
    const settings = stripComments(
      readFileSync(join(sourceRoot, "components", "panels", "SettingsPanel.css"), "utf8"),
    );
    expect(settings).toContain("var(--danger)");
    expect(settings).toContain("var(--success)");
  });

  it("keeps the stealth-gated glyph bubble on palette tokens, without hardcoded colors", () => {
    const css = stripComments(
      readFileSync(join(sourceRoot, "components", "controls", "Tooltip.css"), "utf8"),
    );
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\(/i);
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
      "MessageTimeline.module.css",
      "ModelErrorNotice.module.css",
      "TextResponse.module.css",
      "ThinkingReasoning.module.css",
      "conversation.css",
    ]) {
      const css = stripComments(readFileSync(join(sourceRoot, "components", "chat", file), "utf8"));
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\(/i);
    }
    for (const file of ["ToolCallCard.module.css", "toolCallContent.module.css"]) {
      const css = stripComments(
        readFileSync(join(sourceRoot, "components", "tool-call", file), "utf8"),
      );
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\(/i);
    }
  });

  it("keeps every expanded tool panel tinted and the run-command command pulsing", () => {
    const content = stripComments(
      readFileSync(
        join(sourceRoot, "components", "tool-call", "toolCallContent.module.css"),
        "utf8",
      ),
    );
    const panel = content.match(/\.panel\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(panel).toContain("background: var(--chat-card-bg)");
    expect(panel).toContain("border: 1px solid var(--glass-line)");
    expect(panel).not.toContain("margin-left");

    const card = stripComments(
      readFileSync(join(sourceRoot, "components", "tool-call", "ToolCallCard.module.css"), "utf8"),
    );
    const body = card.match(/\.body\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(body).not.toContain("22px");
    expect(card).toMatch(/\.primary\[data-running="true"\]/);
    expect(card).toContain("animation: tool-call-shine");
  });

  it("keeps every scrollbar hairline and rejects standard thin overrides", () => {
    // Windows/Chromium 默认滚动条约 15px；`scrollbar-width: thin` 还会让
    // Chromium 忽略 `::-webkit-scrollbar` 的 4px 规则。全局只允许 base.css
    // 定义滚动条，且宽高必须是 4px（隐藏态可用 display:none / 0）。
    const base = stripComments(readFileSync(join(sourceRoot, "styles", "base.css"), "utf8"));
    expect(base).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*4px;[^}]*height:\s*4px;/);
    expect(base).toMatch(/::-webkit-scrollbar-button\s*\{[^}]*display:\s*none;/);
    expect(base).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--glass-line\);/);

    const offenders = cssFiles.filter((file) =>
      /scrollbar-width:\s*thin/.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(offenders).toEqual([]);

    const scrollbarSizes = cssFiles.flatMap((file) => {
      const css = stripComments(readFileSync(file, "utf8"));
      return [...css.matchAll(/::-webkit-scrollbar(?:\s*:[a-z-]+)?\s*\{([^}]*)\}/g)].flatMap(
        (match) =>
          [...(match[1] as string).matchAll(/(?:width|height):\s*(\d+)px/g)].map((size) => size[1]),
      );
    });
    expect(scrollbarSizes.filter((size) => size !== "0" && size !== "4")).toEqual([]);
  });

  it("keeps the edit diff on a white paper card with tinted change rows", () => {
    // 参考 UI 是白底卡片：变更行用淡红/淡绿整行底色和同色行号、左侧粗色条，
    // 不能回退到工具面板的灰色 --chat-card-bg 或纯文字 diff。
    const tokens = stripComments(readFileSync(join(sourceRoot, "styles", "tokens.css"), "utf8"));
    expect(tokens).toContain("--diff-remove-bg:");
    expect(tokens).toContain("--diff-add-bg:");

    const css = stripComments(
      readFileSync(
        join(sourceRoot, "components", "tool-call", "renderers", "edit.module.css"),
        "utf8",
      ),
    );
    const panel = css.match(/\.diffPanel\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(panel).toContain("background: var(--paper)");
    expect(panel).not.toContain("var(--chat-card-bg)");

    const removed = css.match(/\.diffRow\[data-kind="removed"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(removed).toContain("background: var(--diff-remove-bg)");
    expect(removed).toContain("border-left-color: var(--danger)");

    const added = css.match(/\.diffRow\[data-kind="added"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(added).toContain("background: var(--diff-add-bg)");
    expect(added).toContain("border-left-color: var(--success)");

    expect(css).toMatch(
      /\.diffRow\[data-kind="removed"\]\s+\.lineNumber\s*\{[^}]*color:\s*var\(--danger\);/,
    );
    expect(css).toMatch(
      /\.diffRow\[data-kind="added"\]\s+\.lineNumber\s*\{[^}]*color:\s*var\(--success\);/,
    );
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
      join("components", "panels", "PanelShell.css"),
      join("components", "panels", "SettingsPanel.css"),
      join("components", "panels", "AccountPanel.css"),
      join("components", "panels", "AnnouncementList.css"),
      join("components", "panels", "workspace", "DirectoryTree.css"),
    ]) {
      const css = stripComments(readFileSync(join(sourceRoot, file), "utf8"));
      expect(css, file).not.toMatch(/font-size:\s*[\d.]+px/);
    }
  });

  it("keeps the light baseline neutral and uses a platform-aware Chinese font stack", () => {
    const tokens = readFileSync(join(sourceRoot, "styles", "tokens.css"), "utf8");
    expect(tokens).toContain("--app-ui-font-family:");
    expect(tokens).toContain('"PingFang SC", "苹方-简", "Segoe UI Variable", "Noto Sans SC"');
    expect(tokens).toContain("--ink-tint: 52 58 64;");
    expect(tokens).toContain("--panel-tint: 247 248 249;");
    expect(tokens).toContain("--paper-tint: 255 255 255;");
    expect(tokens).toContain("--user-wash-base: 0.1;");
    expect(tokens).toContain(
      "--user-wash: rgb(var(--mint-tint) / calc(var(--user-wash-base) * var(--fade)));",
    );
    expect(tokens).toContain("--placeholder: rgb(var(--ink-tint) / calc(0.42 * var(--fade)));");
  });
});
