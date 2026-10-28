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
