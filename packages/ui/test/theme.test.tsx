import type { DesktopBridge } from "@answra/shared";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  colorGroupTokens,
  loadColorScheme,
  useAppTheme,
  useColorScheme,
  type ColorGroupOverrides,
  type ColorScheme,
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
    for (const key of ["--ink-tint", "--glass-tint", "--danger-tint", "--glass-base"]) {
      style.removeProperty(key);
    }
  });

  it("expands a group hex to all raw tokens of the group", () => {
    const tokens = colorGroupTokens({ danger: "#c0453e" });
    expect(tokens["--danger-tint"]).toBe("192 69 62");
  });

  it("ignores invalid hex values", () => {
    const tokens = colorGroupTokens({ danger: "not-a-color" });
    expect(tokens["--danger-tint"]).toBeUndefined();
  });

  it("lets user group overrides win over ambient push", () => {
    const bridge = createBridge();
    const { rerender } = render(
      <Harness bridge={bridge} ambientFollow colorGroups={{ surface: "#aabbcc" }} />,
    );
    act(() => bridge.emit({ ok: true, hex: "#101018", luminance: 0.05 }));
    // ambient 推送了 --glass-tint，但用户"背景"分组覆盖优先
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("170 187 204");
    // 未被用户覆盖的 ambient 键仍然生效
    expect(document.documentElement.style.getPropertyValue("--glass-base")).toBe("0.55");

    // 关闭变色龙：ambient 键清除，用户覆盖保留
    rerender(<Harness bridge={bridge} ambientFollow={false} colorGroups={{ surface: "#aabbcc" }} />);
    expect(document.documentElement.style.getPropertyValue("--glass-base")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--glass-tint")).toBe("170 187 204");
  });
});

describe("color scheme", () => {
  function SchemeHarness({ scheme }: { scheme: ColorScheme }) {
    useColorScheme(scheme);
    return null;
  }

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });

  it("writes explicit light/dark to data-theme", () => {
    const { rerender } = render(<SchemeHarness scheme="dark" />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    rerender(<SchemeHarness scheme="light" />);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("resolves auto from prefers-color-scheme", () => {
    render(<SchemeHarness scheme="auto" />);
    // jsdom 不实现 matchMedia，auto 回落浅色
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("loads stored scheme and falls back to auto", () => {
    expect(loadColorScheme()).toBe("auto");
    localStorage.setItem("answra-color-scheme", "dark");
    expect(loadColorScheme()).toBe("dark");
    localStorage.setItem("answra-color-scheme", "bogus");
    expect(loadColorScheme()).toBe("auto");
  });
});
