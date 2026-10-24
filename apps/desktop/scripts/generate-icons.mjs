import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import png2icons from "png2icons";

/**
 * 从 brand/owl.svg 产出 electron-builder 需要的全套图标：
 *   build/icon.ico  (Windows，多尺寸)
 *   build/icon.icns (macOS)
 *   build/icon.png  (512px，通用/文档用)
 * 换正式 logo 时只需替换 owl.svg 后重跑本脚本。
 */
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = path.join(desktopRoot, "brand", "owl.svg");
const buildDir = path.join(desktopRoot, "build");

function renderPng(svg, width) {
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
}

const svg = await readFile(svgPath);
const master = renderPng(svg, 1024);
const preview = renderPng(svg, 512);

await mkdir(buildDir, { recursive: true });
await writeFile(
  path.join(buildDir, "icon.ico"),
  png2icons.createICO(master, png2icons.BILINEAR, 0, true),
);
await writeFile(
  path.join(buildDir, "icon.icns"),
  png2icons.createICNS(master, png2icons.BILINEAR, 0),
);
await writeFile(path.join(buildDir, "icon.png"), preview);
console.log("[icons] wrote build/icon.ico, build/icon.icns, build/icon.png");
