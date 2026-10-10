import type { DesktopBridge } from "@answra/shared";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  colorGroupTokens,
  useAppTheme,
  type ColorGroupOverrides,
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
