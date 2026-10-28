import type { DesktopBridge } from "@answra/shared";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTokens } from "../src/hooks/useAmbientTheme";
import { type ColorGroupOverrides, colorGroupTokens, useAppTheme } from "../src/theme";

interface AmbientPayload {
  ok: boolean;
  hex: string;
  luminance: number;
}

type TestBridge = DesktopBridge & { emit: (payload: AmbientPayload) => void };

function createBridge(): TestBridge {
  let listener: ((payload: AmbientPayload) => void) | undefined;
  const bridge = {
    fitContent: vi.fn(),
    close: vi.fn(),
    onAmbientColor: vi.fn((cb: (payload: AmbientPayload) => void) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    }),
    emit: (payload: AmbientPayload) => listener?.(payload),
  };
  return bridge as unknown as TestBridge;
}

function Harness({
  bridge,
  ambientFollow,
  colorGroups,
}: {
  bridge?: DesktopBridge;
  ambientFollow: boolean;
  colorGroups: ColorGroupOverrides;
}) {
  useAppTheme(bridge, { ambientFollow, colorGroups });
  return null;
}

describe("color group overrides", () => {
  afterEach(() => {
    const style = document.documentElement.style;
    for (const key of [
      "--ink-tint",
      "--glass-tint",
      "--danger-tint",
      "--panel-tint",
      "--line-tint",
      "--edge-tint",
      "--warning-tint",
      "--success-tint",
    ]) {
      style.removeProperty(key);
    }
    delete document.documentElement.dataset.theme;
  });

  it("expands a group hex to all raw tokens of the group", () => {
    const tokens = colorGroupTokens({ danger: "#c0453e" });
    expect(tokens["--danger-tint"]).toBe("192 69 62");
    // 「描边」组必须同时覆盖结构轮廓与控件描边，否则用户选色只改一半
    const line = colorGroupTokens({ line: "#c0453e" });
    expect(line["--line-tint"]).toBe("192 69 62");
    expect(line["--edge-tint"]).toBe("192 69 62");
  });

  it("ignores invalid hex values", () => {
    const tokens = colorGroupTokens({ danger: "not-a-color" });
    expect(tokens["--danger-tint"]).toBeUndefined();
  });

  it("gives ambient exclusive control over colors while chameleon is on", () => {
    const bridge = createBridge();
    const { rerender } = render(
      <Harness bridge={bridge} ambientFollow colorGroups={{ surface: "#aabbcc" }} />,
    );
    act(() => bridge.emit({ ok: true, hex: "#101018", luminance: 0.05 }));
    // 变色龙接管表面固有色：胶囊/面板取背景主色原色
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("16 16 24");
    expect(document.documentElement.style.getPropertyValue("--panel-tint")).toBe("16 16 24");
    // 文字/描边/交互态不由变色龙改写，仍留给调色板与用户选色
    expect(document.documentElement.style.getPropertyValue("--ink-tint")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--line-tint")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--hover-base")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--warning-tint")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--success-tint")).toBe("");

    // 关闭变色龙：ambient 键清除，用户覆盖恢复生效
    rerender(
      <Harness bridge={bridge} ambientFollow={false} colorGroups={{ surface: "#aabbcc" }} />,
    );
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("170 187 204");
    // 背景组覆盖同时作用于面板
    expect(document.documentElement.style.getPropertyValue("--panel-tint")).toBe("170 187 204");
  });

  it("keeps user picks for non-surface groups while chameleon is on", () => {
    // 变色龙只接管表面：用户选的字色/描边色不能被它抹掉
    const bridge = createBridge();
    render(
      <Harness
        bridge={bridge}
        ambientFollow
        colorGroups={{ text: "#112233", line: "#445566", surface: "#aabbcc" }}
      />,
    );
    act(() => bridge.emit({ ok: true, hex: "#101018", luminance: 0.05 }));
    expect(document.documentElement.style.getPropertyValue("--ink-tint")).toBe("17 34 51");
    expect(document.documentElement.style.getPropertyValue("--line-tint")).toBe("68 85 102");
    expect(document.documentElement.style.getPropertyValue("--edge-tint")).toBe("68 85 102");
    // 同键冲突时表面以变色龙采样结果为准
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("16 16 24");
  });
});

describe("color scheme resolution", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("follows the background luminance while chameleon is on", () => {
    const bridge = createBridge();
    render(<Harness bridge={bridge} ambientFollow colorGroups={{}} />);

    act(() => bridge.emit({ ok: true, hex: "#101018", luminance: 0.05 }));
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => bridge.emit({ ok: true, hex: "#f5f2ec", luminance: 0.9 }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to the system scheme when chameleon is off", () => {
    render(<Harness bridge={undefined} ambientFollow={false} colorGroups={{}} />);
    // jsdom 不实现 matchMedia，回落浅色
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to the system scheme when sampling fails", () => {
    const bridge = createBridge();
    render(<Harness bridge={bridge} ambientFollow colorGroups={{}} />);
    act(() => bridge.emit({ ok: false, hex: "#101018", luminance: 0.05 }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("ambient surface derivation", () => {
  afterEach(() => {
    applyTokens(undefined);
  });

  it("drops every ambient override when chameleon turns off", () => {
    const bridge = createBridge();
    const { rerender } = render(<Harness ambientFollow bridge={bridge} colorGroups={{}} />);
    act(() => bridge.emit({ ok: true, hex: "#808080", luminance: 0.22 }));
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("128 128 128");
    expect(document.documentElement.style.getPropertyValue("--line-base")).toBe("0");
    expect(document.documentElement.style.getPropertyValue("--shadow-base")).toBe("0");

    rerender(<Harness ambientFollow={false} bridge={bridge} colorGroups={{}} />);
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--paper-tint")).toBe("");
    // 结构轮廓与投影必须回落样式表默认，否则关掉变色龙后条与面板永久失去边界
    expect(document.documentElement.style.getPropertyValue("--line-base")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--shadow-base")).toBe("");
  });

  it("ignores a repeated sample of the same background color", () => {
    // 主进程轮询不停推送：hex 未变时不再重写令牌，避免周期性样式重算
    const bridge = createBridge();
    render(<Harness ambientFollow bridge={bridge} colorGroups={{}} />);
    act(() => bridge.emit({ ok: true, hex: "#808080", luminance: 0.22 }));
    // 手动改动内联值，用重复采样验证不会被重新写入
    document.documentElement.style.setProperty("--glass-tint", "1 1 1");
    act(() => bridge.emit({ ok: true, hex: "#808080", luminance: 0.22 }));
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("1 1 1");
  });
});
