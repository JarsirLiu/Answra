import { parseAnswraEnv } from "@answra/shared";
import { describe, expect, it } from "vitest";

/**
 * shared 契约层的纯函数测试。
 * 放在 desktop 测试套件内：desktop 依赖 shared，避免为单函数单独引入测试设施。
 */
describe("parseAnswraEnv", () => {
  it("passes through valid environment values", () => {
    expect(parseAnswraEnv("production")).toBe("production");
    expect(parseAnswraEnv("test")).toBe("test");
    expect(parseAnswraEnv("development")).toBe("development");
  });

  it("falls back to development for invalid or missing values", () => {
    expect(parseAnswraEnv(undefined)).toBe("development");
    expect(parseAnswraEnv("")).toBe("development");
    expect(parseAnswraEnv("Production")).toBe("development"); // 大小写敏感
    expect(parseAnswraEnv("staging")).toBe("development");
  });
});

