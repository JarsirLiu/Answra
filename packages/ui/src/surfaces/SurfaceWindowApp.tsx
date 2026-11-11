import { type DesktopBridge, parseSurfaceSpec, type SurfaceWindowState } from "@answra/shared";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useFitContent } from "../hooks/useFitContent";
import { useStealthDocumentFlag } from "../hooks/useStealthDocumentFlag";
import { loadAppOpacity, loadColorGroups, useAppTheme } from "../theme";
import { ICON_SM } from "../tokens";
import { SurfaceNodeView } from "./SurfaceNodeView";
import "./SurfaceWindow.css";

interface SurfaceWindowAppProps {
  /** 桌面平台桥；默认使用 preload 注入的 window.answra，测试可注入 mock。 */
  bridge?: DesktopBridge;
}

/** 独立浮窗渲染器：只消费主进程校验过的 SurfaceSpec。 */
export function SurfaceWindowApp({ bridge }: SurfaceWindowAppProps) {
  const platform = bridge ?? (globalThis as { answra?: DesktopBridge }).answra;
  const [state, setState] = useState<SurfaceWindowState | null>(null);
  useAppTheme(undefined, { ambientFollow: false, colorGroups: loadColorGroups() });
  useStealthDocumentFlag(Boolean(state?.stealth));

  useEffect(() => {
    document.documentElement.style.setProperty("--fade", String(loadAppOpacity()));
    return () => {
      document.documentElement.style.removeProperty("--fade");
    };
  }, []);

  useEffect(() => {
    const unsubscribe = platform?.onSurfaceState?.((next) => {
      const parsed = parseSurfaceSpec(next.spec);
      setState(parsed.ok ? { spec: parsed.spec, stealth: next.stealth } : null);
    });
    platform?.requestSurfaceState?.();
    return unsubscribe;
  }, [platform]);

  const measureBridge = platform?.fitSurface ? { fitContent: platform.fitSurface } : undefined;
  const { ref } = useFitContent(measureBridge);

  useEffect(() => {
    if (!state || state.spec.window?.dismissible === false) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") platform?.dismissSurface?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [platform, state]);

  if (!state) return <main aria-hidden="true" className="surface-window-root" ref={ref} />;

  const dismissible = state.spec.window?.dismissible !== false;
  return (
    <main className="surface-window-root" ref={ref}>
      <section aria-label={state.spec.title ?? "浮窗"} className="surface-card" role="dialog">
        {(state.spec.title || dismissible) && (
          <header className="surface-card-header">
            {state.spec.title ? <h1 className="surface-card-title">{state.spec.title}</h1> : null}
            {dismissible ? (
              <button
                aria-label="关闭浮窗"
                className="surface-card-close surface-interactive"
                onClick={() => platform?.dismissSurface?.()}
                type="button"
              >
                <X aria-hidden="true" size={ICON_SM} />
              </button>
            ) : null}
          </header>
        )}
        <div className="surface-card-body">
          <SurfaceNodeView
            node={state.spec.root}
            onAction={(actionId) => platform?.sendSurfaceAction?.(actionId)}
          />
        </div>
      </section>
    </main>
  );
}
