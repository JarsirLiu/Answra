import type {
  DesktopBridge,
  ImeCandidateAction,
  ImeCandidateSnapshot,
  ImeState,
} from "@answra/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImeCandidatePopup } from "../components/panels/ImeCandidatePopup";
import "./ImeCandidateWindowApp.css";

interface ImeCandidateWindowAppProps {
  bridge?: DesktopBridge;
}

const EMPTY_STATE: ImeState = {
  enabled: false,
  inputMode: "chinese",
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};
const EMPTY_SNAPSHOT: ImeCandidateSnapshot = { state: EMPTY_STATE };

/** Renderer for the independent, non-activating native candidate window. */
export function ImeCandidateWindowApp({ bridge }: ImeCandidateWindowAppProps) {
  const platform = bridge ?? (globalThis as { answra?: DesktopBridge }).answra;
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const { state } = snapshot;
  const rootRef = useRef<HTMLDivElement>(null);
  const lastRenderSignatureRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = platform?.onImeCandidateState?.(setSnapshot);
    platform?.requestImeCandidateState?.();
    return () => unsubscribe?.();
  }, [platform]);

  useLayoutEffect(() => {
    if (!snapshot.targetId || snapshot.generation === undefined) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const root = rootRef.current;
        if (!root) return;
        const popup = root.querySelector<HTMLElement>(".ime-candidate-popup");
        const describeElement = (element: HTMLElement | null) => {
          if (!element) return undefined;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            text: element.innerText,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            childCount: element.childElementCount,
          };
        };
        const details = {
          event: "candidate-rendered" as const,
          targetId: "ime-candidate-window",
          ownerTargetId: snapshot.targetId,
          generation: snapshot.generation,
          preedit: state.preedit,
          candidates: state.candidates,
          selectedIndex: state.selectedIndex,
          page: state.page,
          documentVisibility: document.visibilityState,
          documentHasFocus: document.hasFocus(),
          candidateRoot: describeElement(root),
          candidatePopup: describeElement(popup),
        };
        const signature = JSON.stringify(details);
        if (signature === lastRenderSignatureRef.current) return;
        lastRenderSignatureRef.current = signature;
        platform?.imeDiagnostic?.(details);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [
    platform,
    snapshot.generation,
    snapshot.targetId,
    state.candidates,
    state.page,
    state.preedit,
    state.selectedIndex,
  ]);

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
          if (key === "PageUp" || key === "PageDown")
            sendAction({
              type: "navigate",
              key,
              targetId: snapshot.targetId ?? "",
              generation: snapshot.generation ?? -1,
            });
        }}
        onSelect={(index) =>
          sendAction({
            type: "select",
            index,
            targetId: snapshot.targetId ?? "",
            generation: snapshot.generation ?? -1,
          })
        }
        state={state}
      />
    </div>
  );
}
