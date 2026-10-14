import type { DesktopBridge, ImeCandidateAction, ImeState } from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImeCandidatePopup } from "../components/panels/ImeCandidatePopup";
import "./ImeCandidateWindowApp.css";

interface ImeCandidateWindowAppProps {
  bridge?: DesktopBridge;
}

const EMPTY_STATE: ImeState = {
  enabled: false,
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

/** Renderer for the independent, non-activating native candidate window. */
export function ImeCandidateWindowApp({ bridge }: ImeCandidateWindowAppProps) {
  const platform = bridge ?? (globalThis as { answra?: DesktopBridge }).answra;
  const [state, setState] = useState(EMPTY_STATE);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = platform?.onImeCandidateState?.(setState);
    platform?.requestImeCandidateState?.();
    return () => unsubscribe?.();
  }, [platform]);

  useEffect(() => {
    const root = rootRef.current;
    const fitImeCandidate = platform?.fitImeCandidate;
    if (
      !root ||
      !fitImeCandidate ||
      !state.enabled ||
      (!state.preedit && state.candidates.length === 0)
    )
      return;
    const reportSize = () => {
      const bounds = root.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        fitImeCandidate({ width: bounds.width, height: bounds.height });
      }
    };
    const observer = new ResizeObserver(reportSize);
    observer.observe(root);
    reportSize();
    return () => observer.disconnect();
  }, [platform, state.candidates.length, state.enabled, state.preedit]);

  const sendAction = useCallback(
    (action: ImeCandidateAction) => platform?.sendImeCandidateAction?.(action),
    [platform],
  );

  return (
    <div className="ime-candidate-window-root" ref={rootRef}>
      <ImeCandidatePopup
        onNavigate={(key) => {
          if (key === "PageUp" || key === "PageDown") sendAction({ type: "navigate", key });
        }}
        onSelect={(index) => sendAction({ type: "select", index })}
        state={state}
      />
    </div>
  );
}
