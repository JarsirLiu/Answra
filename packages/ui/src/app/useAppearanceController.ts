import type { DesktopBridge } from "@answra/shared";
import { useEffect, useState } from "react";
import { useAmbientFollow } from "../hooks/useAmbientFollow";
import { AMBIENT_VEIL_STORAGE_KEY } from "../model";
import {
  type ColorGroupOverrides,
  loadAppOpacity,
  loadColorGroups,
  saveAppOpacity,
  useAppTheme,
} from "../theme";

/** Owns renderer appearance preferences and applies one shared token set to every surface. */
export function useAppearanceController(bridge: DesktopBridge | undefined) {
  const [ambientFollow, setAmbientFollow] = useAmbientFollow();
  const [opacity, setOpacityState] = useState(loadAppOpacity);
  const [colorGroups] = useState<ColorGroupOverrides>(loadColorGroups);

  useAppTheme(bridge, { ambientFollow, colorGroups });

  useEffect(() => {
    bridge?.setAmbientFollow?.(ambientFollow);
  }, [bridge, ambientFollow]);

  // 已移除的「隐蔽强度」档位：清掉旧版残留值，避免以后同名键读回过期偏好。
  useEffect(() => {
    localStorage.removeItem(AMBIENT_VEIL_STORAGE_KEY);
  }, []);

  // All surfaces read the same root-level perception tokens, including floating layers.
  useEffect(() => {
    document.documentElement.style.setProperty("--fade", String(opacity));
    return () => {
      document.documentElement.style.removeProperty("--fade");
    };
  }, [opacity]);

  function setOpacity(value: number) {
    setOpacityState(value);
    saveAppOpacity(value);
  }

  return {
    ambientFollow,
    setAmbientFollow,
    opacity,
    setOpacity,
    colorGroups,
  };
}
