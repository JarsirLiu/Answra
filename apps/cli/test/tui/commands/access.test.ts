import { describe, expect, it } from "vitest";
import {
  ALWAYS_AVAILABLE,
  accessDenial,
  assertAccessAllowed,
  idleOnly,
} from "../../../src/tui/commands/access";

const IDLE = { runActive: false, activeRunActive: false, compactionActive: false };
const RUNNING = { runActive: true, activeRunActive: true, compactionActive: false };
const BACKGROUND_RUNNING = { runActive: true, activeRunActive: false, compactionActive: false };
const COMPACTING = { runActive: false, activeRunActive: false, compactionActive: true };

describe("accessDenial", () => {
  it("always allows read-only access", () => {
    expect(accessDenial(ALWAYS_AVAILABLE, RUNNING)).toBeUndefined();
    expect(accessDenial(ALWAYS_AVAILABLE, COMPACTING)).toBeUndefined();
  });

  it("allows idle-only access while nothing is running", () => {
    expect(accessDenial(idleOnly("切换模型"), IDLE)).toBeUndefined();
  });

  it("names the blocked action while a run is active", () => {
    expect(accessDenial(idleOnly("切换模型"), RUNNING)).toBe(
      "当前运行中，先按 Esc 中断或等待本轮结束后再切换模型。",
    );
  });

  it("lets active-session actions run while only a background session is busy", () => {
    expect(accessDenial(idleOnly("清除会话", "active"), BACKGROUND_RUNNING)).toBeUndefined();
    expect(accessDenial(idleOnly("切换模型"), BACKGROUND_RUNNING)).toBe(
      "当前运行中，先按 Esc 中断或等待本轮结束后再切换模型。",
    );
    expect(accessDenial(idleOnly("清除会话", "active"), RUNNING)).toBe(
      "当前运行中，先按 Esc 中断或等待本轮结束后再清除会话。",
    );
  });

  it("uses a separate message while compaction is active", () => {
    expect(accessDenial(idleOnly("清除会话", "active"), COMPACTING)).toBe(
      "正在压缩上下文，先按 Esc 取消或等待完成后再清除会话。",
    );
  });
});

describe("assertAccessAllowed", () => {
  it("throws the denial message for panel actions", () => {
    expect(() => assertAccessAllowed(idleOnly("恢复会话"), RUNNING)).toThrow(
      "当前运行中，先按 Esc 中断或等待本轮结束后再恢复会话。",
    );
  });

  it("does nothing when access is allowed", () => {
    expect(() => assertAccessAllowed(idleOnly("恢复会话"), IDLE)).not.toThrow();
  });
});
