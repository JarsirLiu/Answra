import {
  cloneElement,
  createContext,
  type FocusEvent,
  type HTMLAttributes,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import "./Tooltip.css";

/** Context 缺省值 = 隐身（fail-closed）：未接 Provider 的调用面一律不出提示。 */
const TooltipStealthContext = createContext(true);

const SHOW_DELAY_MS = 300;
const EDGE_MARGIN = 8;

interface TooltipProps {
  label: string;
  children: ReactNode;
}

/** 原生 title 的 OS 提示无法按隐身状态关闭（见 2026-10-31 bug-fix Note），
    悬停说明一律走这里：隐身开启时连事件处理都不启动，气泡根本不渲染。 */
export function TooltipProvider({ stealth, children }: { stealth: boolean; children: ReactNode }) {
  return (
    <TooltipStealthContext.Provider value={stealth}>{children}</TooltipStealthContext.Provider>
  );
}

type DomEvent<T> = MouseEvent<T> | FocusEvent<T>;

function chainDomHandler<T extends MouseEvent<Element> | FocusEvent<Element>>(
  domHandler: ((event: T) => void) | undefined,
  tipHandler: (event: T) => void,
) {
  return (event: T) => {
    domHandler?.(event);
    tipHandler(event);
  };
}

export function Tooltip({ label, children }: TooltipProps) {
  const stealth = useContext(TooltipStealthContext);
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null);
  const delayRef = useRef<number | undefined>(undefined);
  const targetRef = useRef<Element | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  const hide = useCallback(() => {
    window.clearTimeout(delayRef.current);
    targetRef.current = null;
    setBubble(null);
  }, []);

  const show = useCallback(
    (event: DomEvent<Element>) => {
      if (stealth) return;
      targetRef.current = event.currentTarget;
      window.clearTimeout(delayRef.current);
      delayRef.current = window.setTimeout(() => {
        const element = targetRef.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        setBubble({ x: rect.left + rect.width / 2, y: rect.top });
      }, SHOW_DELAY_MS);
    },
    [stealth],
  );

  // 隐身切换即刻生效：正在显示的气泡立即收回。
  useEffect(() => {
    if (stealth) hide();
    return () => window.clearTimeout(delayRef.current);
  }, [hide, stealth]);

  // 页面滚动即收回，否则气泡会悬空脱离控件。
  useEffect(() => {
    if (!bubble) return;
    const retract = () => setBubble(null);
    window.addEventListener("scroll", retract, true);
    return () => window.removeEventListener("scroll", retract, true);
  }, [bubble]);

  // 靠近窗口边缘的按钮（如工具栏最右）气泡以中心线绘制会出画，按实测宽度做水平钳制。
  useLayoutEffect(() => {
    if (!bubble || !bubbleRef.current) return;
    const half = bubbleRef.current.offsetWidth / 2 + EDGE_MARGIN;
    const x = Math.min(Math.max(bubble.x, half), window.innerWidth - half);
    if (x !== bubble.x) setBubble({ ...bubble, x });
  }, [bubble]);

  if (!isValidElement(children)) return children;
  const child = children as ReactElement<HTMLAttributes<HTMLElement>>;
  const props = child.props;
  const wrapped = cloneElement(child, {
    onMouseEnter: chainDomHandler(props.onMouseEnter, show),
    onMouseLeave: chainDomHandler(props.onMouseLeave, hide),
    onFocus: chainDomHandler(props.onFocus, show),
    onBlur: chainDomHandler(props.onBlur, hide),
  });

  return (
    <>
      {wrapped}
      {bubble &&
        createPortal(
          <div
            aria-hidden="true"
            className="tooltip-bubble"
            ref={bubbleRef}
            role="presentation"
            style={{ left: bubble.x, top: bubble.y }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
