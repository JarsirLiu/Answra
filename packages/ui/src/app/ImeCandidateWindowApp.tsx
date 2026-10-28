import type {
  DesktopBridge,
  ImeCandidateAction,
  ImeCandidateSnapshot,
  ImeState,
} from "@answra/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImeCandidatePopup } from "../components/panels/ImeCandidatePopup";
import {
  type ColorGroupOverrides,
  loadAmbientFollow,
  loadAppOpacity,
  loadColorGroups,
  useAppTheme,
} from "../theme";
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
const EMPTY_SNAPSHOT: ImeCandidateSnapshot = {
  phase: "empty",
  state: EMPTY_STATE,
  revision: 0,
};

/** Renderer for the independent, non-activating native candidate window. */
export function ImeCandidateWindowApp({ bridge }: ImeCandidateWindowAppProps) {
  const platform = bridge ?? (globalThis as { answra?: DesktopBridge }).answra;
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const state = snapshot.phase === "visible" ? snapshot.state : EMPTY_STATE;
  const rootRef = useRef<HTMLDivElement>(null);
  const lastRenderSignatureRef = useRef<string | undefined>(undefined);
  // 候选窗是独立窗口，没有外观控制器：读同一份偏好 + 主进程广播的采样结果，
  // 复用 useAppTheme 落到与主窗口相同的 data-theme 与感知令牌。
  const [ambientFollow] = useState(loadAmbientFollow);
  const [colorGroups] = useState<ColorGroupOverrides>(loadColorGroups);
  useAppTheme(platform, { ambientFollow, colorGroups });

  useEffect(() => {
    document.documentElement.style.setProperty("--fade", String(loadAppOpacity()));
  }, []);

  useEffect(() => {
    const unsubscribe = platform?.onImeCandidateState?.((next) => {
      setSnapshot((current) => (next.revision <= current.revision ? current : next));
    });
    platform?.requestImeCandidateState?.();
    return () => unsubscribe?.();
  }, [platform]);

  useLayoutEffect(() => {
    if (snapshot.phase !== "visible") return;
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
          revision: snapshot.revision,
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
    snapshot.revision,
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
      // scrollWidth/scrollHeight 反映未裁剪的内容：窗口偏小时仍能上报真实内容尺寸，
      // 否则上报值会被夹在当前窗口宽度内，窗口只能收窄不能恢复。
      const width = Math.max(bounds.width, root.scrollWidth);
      const height = Math.max(bounds.height, root.scrollHeight);
      if (width > 0 && height > 0) {
        fitImeCandidate({ width, height });
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
