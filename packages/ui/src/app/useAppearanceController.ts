import type { DesktopBridge } from "@answra/shared";
import { useEffect, useState } from "react";
import { useAmbientFollow } from "../hooks/useAmbientFollow";
import { APP_OPACITY_STORAGE_KEY } from "../model";
import { type ColorGroupOverrides, loadColorGroups, useAppTheme } from "../theme";

/** Owns renderer appearance preferences and applies one shared token set to every surface. */
export function useAppearanceController(bridge: DesktopBridge | undefined) {
  const [ambientFollow, setAmbientFollow] = useAmbientFollow();
  const [opacity, setOpacityState] = useState(() => {
    const stored = Number(localStorage.getItem(APP_OPACITY_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 0.5 && stored <= 1 ? stored : 1;
  });
  const [colorGroups] = useState<ColorGroupOverrides>(loadColorGroups);

  useAppTheme(bridge, { ambientFollow, colorGroups });

  useEffect(() => {
    bridge?.setAmbientFollow?.(ambientFollow);
  }, [bridge, ambientFollow]);

  // All surfaces read the same root-level perception tokens, including floating layers.
  useEffect(() => {
    document.documentElement.style.setProperty("--fade", String(opacity));
    return () => {
      document.documentElement.style.removeProperty("--fade");
    };
  }, [opacity]);

  function setOpacity(value: number) {
    setOpacityState(value);
    localStorage.setItem(APP_OPACITY_STORAGE_KEY, String(value));
  }

  return { ambientFollow, setAmbientFollow, opacity, setOpacity, colorGroups };
}
