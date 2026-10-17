import type { DesktopBridge } from "@answra/shared";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTokens } from "../src/hooks/useAmbientTheme";
import { AMBIENT_VEIL_STORAGE_KEY, type AmbientVeilLevel } from "../src/model";
import {
  type ColorGroupOverrides,
  colorGroupTokens,
  loadAmbientVeil,
  saveAmbientVeil,
  useAppTheme,
} from "../src/theme";

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
  ambientVeil,
}: {
  bridge?: DesktopBridge;
  ambientFollow: boolean;
  colorGroups: ColorGroupOverrides;
  ambientVeil?: AmbientVeilLevel;
}) {
  useAppTheme(bridge, {
    ambientFollow,
    colorGroups,
    ...(ambientVeil ? { ambientVeil } : {}),
  });
  return null;
}

describe("color group overrides", () => {
  afterEach(() => {
    const style = document.documentElement.style;
    for (const key of ["--ink-tint", "--glass-tint", "--danger-tint", "--panel-tint"]) {
      style.removeProperty(key);
    }
    delete document.documentElement.dataset.theme;
  });

  it("expands a group hex to all raw tokens of the group", () => {
    const tokens = colorGroupTokens({ danger: "#c0453e" });
    expect(tokens["--danger-tint"]).toBe("192 69 62");
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
    // 变色龙开启：用户"背景"分组覆盖失效，一切颜色只由 ambient 决定
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("16 16 24");
    expect(document.documentElement.style.getPropertyValue("--hover-base")).toBe("0.1");

    // 关闭变色龙：ambient 键清除，用户覆盖恢复生效
    rerender(
      <Harness bridge={bridge} ambientFollow={false} colorGroups={{ surface: "#aabbcc" }} />,
    );
    expect(document.documentElement.style.getPropertyValue("--hover-base")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("170 187 204");
    // 背景组覆盖同时作用于面板
    expect(document.documentElement.style.getPropertyValue("--panel-tint")).toBe("170 187 204");
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

describe("chameleon veil preference", () => {
  afterEach(() => {
    applyTokens(undefined);
    localStorage.clear();
  });

  it("defaults to the veiled level and ignores invalid stored values", () => {
    expect(loadAmbientVeil()).toBe("veiled");
    localStorage.setItem(AMBIENT_VEIL_STORAGE_KEY, "nonsense");
    expect(loadAmbientVeil()).toBe("veiled");
    saveAmbientVeil("blend");
    expect(loadAmbientVeil()).toBe("blend");
  });

  it("re-derives tokens when the veil level changes without a new sample", () => {
    const bridge = createBridge();
    const { rerender } = render(
      <Harness ambientFollow ambientVeil="readable" bridge={bridge} colorGroups={{}} />,
    );
    act(() => bridge.emit({ ok: true, hex: "#808080", luminance: 0.22 }));
    const readable = document.documentElement.style.getPropertyValue("--ink-tint");

    rerender(<Harness ambientFollow ambientVeil="blend" bridge={bridge} colorGroups={{}} />);
    const blend = document.documentElement.style.getPropertyValue("--ink-tint");

    expect(blend).not.toBe("");
    expect(blend).not.toBe(readable);
    // 表面与描边取背景原色、投影关闭：悬浮层只靠固有色融入背景
    expect(document.documentElement.style.getPropertyValue("--line-tint")).toBe("128 128 128");
    expect(document.documentElement.style.getPropertyValue("--shadow-base")).toBe("0");
  });
});
