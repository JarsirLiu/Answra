import type { DesktopBridge } from "@answra/shared";
import { useEffect, useState } from "react";
import { useAmbientFollow } from "../hooks/useAmbientFollow";
import { type AmbientVeilLevel, DEFAULT_AMBIENT_VEIL } from "../model";
import {
  type ColorGroupOverrides,
  loadAmbientVeil,
  loadAppOpacity,
  loadColorGroups,
  saveAmbientVeil,
  saveAppOpacity,
  useAppTheme,
} from "../theme";

/** Owns renderer appearance preferences and applies one shared token set to every surface. */
export function useAppearanceController(bridge: DesktopBridge | undefined) {
  const [ambientFollow, setAmbientFollow] = useAmbientFollow();
  const [ambientVeil, setVeilState] = useState<AmbientVeilLevel>(loadAmbientVeil);
  const [opacity, setOpacityState] = useState(loadAppOpacity);
  const [colorGroups] = useState<ColorGroupOverrides>(loadColorGroups);

  useAppTheme(bridge, {
    ambientFollow,
    colorGroups,
    ambientVeil: ambientVeil ?? DEFAULT_AMBIENT_VEIL,
  });

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
    saveAppOpacity(value);
  }

  function setAmbientVeil(level: AmbientVeilLevel) {
    setVeilState(level);
    saveAmbientVeil(level);
  }

  return {
    ambientFollow,
    setAmbientFollow,
    ambientVeil,
    setAmbientVeil,
    opacity,
    setOpacity,
    colorGroups,
  };
}
