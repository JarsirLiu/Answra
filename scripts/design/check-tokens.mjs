#!/usr/bin/node
/**
 * Design-token guard for @answra/ui.
 *
 * Scans component CSS for values that bypass the token layer:
 * - literal colors (#hex, rgb(), hsl())
 * - direct raw-token references (--*-tint / --*-base)
 * - Tailwind opacity modifiers on surface utilities (bg-panel/80)
 *
 * tokens.css is the only allowed color source. The unreferenced
 * panels/message-actions variant is explicitly isolated until it is connected;
 * its private palette must be folded into semantic tokens before that changes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const UI_SRC = path.join(ROOT, "packages", "ui", "src");
const TOKENS_CSS = path.join(UI_SRC, "styles", "tokens.css");
const ISOLATED_VARIANT = path.join(
  UI_SRC,
  "components",
  "panels",
  "message-actions",
  "MessageActions.module.css",
);

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi;
const RAW_TOKEN = /var\(--[a-z0-9-]+-(?:tint|base)\b/gi;
const SURFACE_ALPHA = /\b(?:bg|border|text|ring|outline|shadow)-(?:glass|panel|paper)\/\d+/g;
/** 控件尺寸必须走 --control-* / --space-* / --font-*，不能回到 px 字面量。 */
const CONTROL_SIZE_LITERAL =
  /\b(?:font-size|height|min-height|padding(?:-[a-z]+)?|gap|row-gap|column-gap)\s*:\s*[^;{}]*\b\d+(?:\.\d+)?px\b/gi;
/** 品牌薄荷只允许做面；这里拦前景色（图标/文字/描边色）。 */
const ACCENT_FOREGROUND =
  /\b(?:color|fill|stroke|border-color)\s*:\s*[^;{}]*var\(--mint(?:-text|-deep)?\)/gi;

const CONTROL_SIZE_ROOTS = [
  path.join(UI_SRC, "components", "controls"),
  path.join(UI_SRC, "components", "floating-bar"),
];
const ACTION_CHROME_FILES = new Set(
  [
    ["components", "panels", "PanelShell.css"],
    ["components", "panels", "ReplyBar.css"],
    ["components", "panels", "SettingsPanel.css"],
    ["components", "panels", "AnnouncementList.css"],
    ["components", "panels", "AccountPanel.css"],
    ["components", "panels", "InterviewCapturePanel.css"],
    ["components", "panels", "UpdateSettingsGroup.css"],
  ].map((parts) => path.join(UI_SRC, ...parts)),
);

const errors = [];

function walk(directory, extensions) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full, extensions);
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      checkFile(full);
    }
  }
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

function isUnder(file, root) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function locate(text, pattern) {
  const matches = [...text.matchAll(pattern)];
  return matches.map((match) => {
    const before = text.slice(0, match.index);
    const line = before.split(/\r?\n/).length;
    return `${line}: ${match[0]}`;
  });
}

function checkFile(file) {
  const relative = path.relative(ROOT, file).replaceAll("\\", "/");
  const source = readFileSync(file, "utf8");

  if (file.endsWith(".css")) {
    if (file === TOKENS_CSS) return;
    if (file === ISOLATED_VARIANT) return;

    const css = stripCssComments(source);
    const colorHits = locate(css, COLOR_LITERAL);
    const rawHits = locate(css, RAW_TOKEN);
    if (colorHits.length > 0) {
      errors.push(`${relative}: 组件 CSS 不得出现颜色字面量\n  ${colorHits.join("\n  ")}`);
    }
    if (rawHits.length > 0) {
      errors.push(`${relative}: 组件 CSS 不得直接引用原始令牌\n  ${rawHits.join("\n  ")}`);
    }

    const sizeGuarded = CONTROL_SIZE_ROOTS.some((root) => isUnder(file, root));
    if (sizeGuarded) {
      const sizeHits = locate(css, CONTROL_SIZE_LITERAL);
      if (sizeHits.length > 0) {
        errors.push(
          `${relative}: 控件 CSS 不得出现尺寸字面量，请改用 --control-* / --space-* / --font-*\n  ${sizeHits.join("\n  ")}`,
        );
      }
    }

    if (sizeGuarded || ACTION_CHROME_FILES.has(file)) {
      const accentHits = locate(css, ACCENT_FOREGROUND);
      if (accentHits.length > 0) {
        errors.push(
          `${relative}: 薄荷绿只能做实底/填充，不得用作图标或文字前景色\n  ${accentHits.join("\n  ")}`,
        );
      }
    }
    return;
  }

  const alphaHits = locate(source, SURFACE_ALPHA);
  if (alphaHits.length > 0) {
    errors.push(`${relative}: 表面令牌不得用 Tailwind /xx 二次 alpha\n  ${alphaHits.join("\n  ")}`);
  }
}

walk(UI_SRC, [".css", ".ts", ".tsx"]);

if (errors.length > 0) {
  console.error(`✗ 设计令牌检查失败（${errors.length} 项）：\n\n${errors.join("\n\n")}`);
  process.exit(1);
}

console.log("✓ 设计令牌检查通过：组件 CSS 只消费语义令牌。");
