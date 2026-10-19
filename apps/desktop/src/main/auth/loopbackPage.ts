/**
 * 环回回调结果页（开发态专用，纯字符串渲染，不依赖 Electron）。
 *
 * 视觉令牌复刻站点设计系统（见 `web/src/app/globals.css`）：暖中性底 + Indigo 主色、
 * 发丝边框、柔光晕与网格氛围层、Geist → 系统字体回退栈，并随系统深浅色切换。
 * 页面必须自包含：不加载任何外部字体/图标/脚本，离线也能立即打开。
 */

export type LoopbackOutcome = "success" | "cancelled";

interface LoopbackCopy {
  lang: string;
  successTitle: string;
  successBody: string;
  cancelledTitle: string;
  cancelledBody: string;
}

const zhCopy: LoopbackCopy = {
  lang: "zh",
  successTitle: "登录完成",
  successBody: "已授权 Answra 桌面端，可以关闭这个标签页。账号与套餐信息会自动同步。",
  cancelledTitle: "已取消授权",
  cancelledBody: "本次登录未完成，可以关闭这个标签页，回到桌面端重新登录。",
};

const enCopy: LoopbackCopy = {
  lang: "en",
  successTitle: "You're signed in",
  successBody:
    "Answra desktop is now connected. Close this tab — your account and plan sync automatically.",
  cancelledTitle: "Authorization cancelled",
  cancelledBody: "Sign-in was not completed. Close this tab and start again from Answra desktop.",
};

/** 按浏览器 `Accept-Language` 选中/英文案；无匹配时回英文。 */
export function loopbackCopyFor(acceptLanguage: string | undefined): LoopbackCopy {
  return (acceptLanguage ?? "").toLowerCase().startsWith("zh") ? zhCopy : enCopy;
}

export function renderLoopbackPage(
  acceptLanguage: string | undefined,
  outcome: LoopbackOutcome,
): string {
  const copy = loopbackCopyFor(acceptLanguage);
  const isSuccess = outcome === "success";
  const title = isSuccess ? copy.successTitle : copy.cancelledTitle;
  const body = isSuccess ? copy.successBody : copy.cancelledBody;
  const accent = isSuccess ? "var(--success)" : "var(--danger)";
  const icon = isSuccess
    ? '<path d="M20 6 9 17l-5-5"/>'
    : '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';
  return `<!doctype html>
<html lang="${copy.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Answra · ${title}</title>
<style>
  :root {
    --background: oklch(0.985 0.003 95);
    --card: oklch(1 0 0);
    --foreground: oklch(0.24 0.006 60);
    --muted: oklch(0.50 0.008 60);
    --border: oklch(0.905 0.006 90);
    --primary: oklch(0.52 0.19 266);
    --success: oklch(0.52 0.095 165);
    --danger: oklch(0.58 0.20 28);
    --grid-line: oklch(0.24 0.006 60 / 0.045);
    --glow-1: oklch(0.60 0.17 266 / 0.10);
    --glow-2: oklch(0.55 0.10 200 / 0.06);
    --shadow: 0 1px 2px oklch(0.24 0.006 60 / 0.04), 0 18px 48px oklch(0.24 0.006 60 / 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: oklch(0.165 0.004 60);
      --card: oklch(0.205 0.005 60);
      --foreground: oklch(0.93 0.004 90);
      --muted: oklch(0.66 0.006 70);
      --border: oklch(0.30 0.005 60);
      --primary: oklch(0.68 0.16 266);
      --success: oklch(0.60 0.10 165);
      --danger: oklch(0.62 0.19 28);
      --grid-line: oklch(0.93 0.004 90 / 0.05);
      --glow-1: oklch(0.68 0.16 266 / 0.14);
      --glow-2: oklch(0.55 0.10 200 / 0.08);
      --shadow: 0 1px 2px oklch(0 0 0 / 0.35), 0 18px 48px oklch(0 0 0 / 0.35);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 32px 20px;
    color: var(--foreground);
    background-color: var(--background);
    background-image:
      radial-gradient(720px 420px at 18% -10%, var(--glow-1), transparent 65%),
      radial-gradient(560px 360px at 92% 108%, var(--glow-2), transparent 62%),
      linear-gradient(var(--grid-line) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
    background-size: auto, auto, 56px 56px, 56px 56px;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 420px;
    padding: 36px 32px 32px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--card);
    box-shadow: var(--shadow);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .brand svg { width: 22px; height: 22px; color: var(--primary); }
  .status {
    margin-top: 30px;
    width: 52px;
    height: 52px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 1px solid color-mix(in oklch, ${accent} 24%, transparent);
    background: color-mix(in oklch, ${accent} 12%, transparent);
    color: ${accent};
  }
  .status svg { width: 26px; height: 26px; }
  h1 {
    margin: 18px 0 0;
    font-size: 22px;
    line-height: 1.3;
    letter-spacing: -0.015em;
  }
  p {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.65;
  }
  .rule {
    margin-top: 24px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.01em;
  }
</style>
</head>
<body>
<main>
  <div class="brand">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
      <path d="M8.5 11.5l2.5 2.5 4.5-5"/>
    </svg>
    <span>Answra</span>
  </div>
  <div class="status" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
  </div>
  <h1>${title}</h1>
  <p>${body}</p>
  <div class="rule">Answra Desktop · 127.0.0.1</div>
</main>
</body>
</html>`;
}
