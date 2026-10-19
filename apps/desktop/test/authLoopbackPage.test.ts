import { describe, expect, it } from "vitest";
import { loopbackCopyFor, renderLoopbackPage } from "../src/main/auth/loopbackPage";

/**
 * 环回结果页渲染：纯字符串，覆盖中/英文案、成功/取消两种结果与自包含约束。
 * 视觉令牌来自站点设计系统，这里只断言结构与关键内容，不锁定具体色值。
 */
describe("renderLoopbackPage", () => {
  it("renders the Chinese success copy for zh browsers", () => {
    const html = renderLoopbackPage("zh-CN,zh;q=0.9,en;q=0.8", "success");
    expect(html).toContain('<html lang="zh">');
    expect(html).toContain("登录完成");
    expect(html).toContain("已授权 Answra 桌面端");
    expect(html).not.toContain("已取消授权");
  });

  it("renders the cancellation copy when the outcome is cancelled", () => {
    const html = renderLoopbackPage("zh-CN", "cancelled");
    expect(html).toContain("已取消授权");
    expect(html).not.toContain("登录完成");
  });

  it("falls back to English when the browser locale is not Chinese", () => {
    const html = renderLoopbackPage("en-US,en;q=0.9", "success");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Close this tab");
    expect(renderLoopbackPage(undefined, "success")).toContain('<html lang="en">');
  });

  it("stays self-contained: no external scripts, styles or assets", () => {
    for (const outcome of ["success", "cancelled"] as const) {
      const html = renderLoopbackPage("zh-CN", outcome);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<link\b/i);
      expect(html).not.toMatch(/https?:\/\//);
      // 明暗两套令牌 + 站点品牌色，证明沿用了站点设计系统。
      expect(html).toContain("prefers-color-scheme: dark");
      expect(html).toContain("oklch(0.52 0.19 266)");
      expect(html).toContain("Answra");
    }
  });
});

describe("loopbackCopyFor", () => {
  it("matches any zh-prefixed locale case-insensitively", () => {
    expect(loopbackCopyFor("ZH").lang).toBe("zh");
    expect(loopbackCopyFor("zh-Hant-TW").lang).toBe("zh");
    expect(loopbackCopyFor("fr-FR").lang).toBe("en");
    expect(loopbackCopyFor(undefined).lang).toBe("en");
  });
});
