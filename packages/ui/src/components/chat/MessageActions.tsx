import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styles from "./MessageActions.module.css";
import { type MessageActionIcons, messageActionIcons } from "./messageActionIcons";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

type CueApi = {
  aim: (anchor: HTMLElement, label: string) => void;
  hide: () => void;
};

const CueContext = createContext<CueApi | null>(null);

function Cue({
  label,
  children,
  quiet = false,
}: {
  label: string;
  children: ReactNode;
  quiet?: boolean;
}) {
  const cue = useContext(CueContext);
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !cue) return;
    const hot = node.matches(":hover") || node.contains(document.activeElement);
    if (!hot) return;
    if (quiet) cue.hide();
    else cue.aim(node, label);
  }, [cue, label, quiet]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 悬停提示的命中区域，交互由内部按钮承载
    <span
      ref={ref}
      className={styles.hit}
      onMouseEnter={(event) => {
        if (quiet) return;
        cue?.aim(event.currentTarget, label);
      }}
      onFocus={(event) => {
        if (quiet) return;
        cue?.aim(event.currentTarget, label);
      }}
    >
      {children}
    </span>
  );
}

function RowCues({ children }: { children: ReactNode }) {
  const tipId = useId();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const gaugeRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const labelRef = useRef("");
  const openRef = useRef(false);
  const describedRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [tipTheme, setTipTheme] = useState<"light" | "dark">("light");

  useEffect(() => setMounted(true), []);

  const write = useCallback((bubble: HTMLDivElement, x: number, y: number, width: number) => {
    bubble.style.setProperty("--cue-x", `${x}px`);
    bubble.style.setProperty("--cue-y", `${y}px`);
    bubble.style.setProperty("--cue-w", `${width}px`);
  }, []);

  const measure = useCallback((anchor: HTMLElement, next: string) => {
    const bubble = bubbleRef.current;
    const gauge = gaugeRef.current;
    if (!bubble || !gauge) return null;
    gauge.textContent = next;
    const host = (anchor.querySelector("button, time") as HTMLElement | null) ?? anchor;
    const rect = host.getBoundingClientRect();
    const width = Math.ceil(gauge.offsetWidth + 10);
    const height = Math.ceil(gauge.offsetHeight + 8);
    return {
      host,
      x: Math.round(rect.left + rect.width / 2 - width / 2),
      y: Math.round(rect.top - height - 6),
      width,
    };
  }, []);

  const place = useCallback(
    (anchor: HTMLElement, next: string, reveal: boolean) => {
      const bubble = bubbleRef.current;
      const spot = measure(anchor, next);
      if (!bubble || !spot) return;
      const arriving = reveal && !openRef.current;
      if (arriving) {
        bubble.dataset.hold = "true";
        write(bubble, spot.x, spot.y, spot.width);
        void bubble.offsetWidth;
        delete bubble.dataset.hold;
        openRef.current = true;
        setOpen(true);
      } else if (openRef.current) {
        write(bubble, spot.x, spot.y, spot.width);
      }
      if (describedRef.current && describedRef.current !== spot.host) {
        describedRef.current.removeAttribute("aria-describedby");
      }
      spot.host.setAttribute("aria-describedby", tipId);
      describedRef.current = spot.host;
      const from = anchor.closest("[data-theme]")?.getAttribute("data-theme");
      setTipTheme(from === "dark" ? "dark" : "light");
      setLabel((current) => (current === next ? current : next));
    },
    [measure, tipId, write],
  );

  const aim = useCallback(
    (anchor: HTMLElement, next: string) => {
      anchorRef.current = anchor;
      labelRef.current = next;
      place(anchor, next, true);
    },
    [place],
  );

  const hide = useCallback(() => {
    openRef.current = false;
    anchorRef.current = null;
    describedRef.current?.removeAttribute("aria-describedby");
    describedRef.current = null;
    setOpen(false);
  }, []);

  useIsoLayoutEffect(() => {
    if (!open) return;
    const follow = () => {
      const anchor = anchorRef.current;
      const bubble = bubbleRef.current;
      if (!anchor || !bubble || !openRef.current) return;
      const spot = measure(anchor, labelRef.current);
      if (!spot) return;
      bubble.dataset.hold = "true";
      write(bubble, spot.x, spot.y, spot.width);
      void bubble.offsetWidth;
      delete bubble.dataset.hold;
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open]);

  const api = useMemo<CueApi>(() => ({ aim, hide }), [aim, hide]);

  return (
    <CueContext.Provider value={api}>
      {children}
      {mounted
        ? createPortal(
            <>
              <span ref={gaugeRef} className={styles.tipGauge} aria-hidden="true" />
              <div
                ref={bubbleRef}
                id={tipId}
                role="tooltip"
                data-theme={tipTheme}
                data-up={open ? "true" : undefined}
                className={styles.tip}
                aria-hidden={open ? undefined : true}
              >
                {label}
              </div>
            </>,
            document.body,
          )
        : null}
    </CueContext.Provider>
  );
}

function CueRoot({
  rootRef,
  children,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const cue = useContext(CueContext);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 离开/失焦时统一收起提示的事件委托容器
    <div
      ref={rootRef}
      className={styles.root}
      onMouseLeave={() => cue?.hide()}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        cue?.hide();
      }}
    >
      {children}
    </div>
  );
}

type Vote = "up" | "down" | null;

const ROLL_MS = 400;

function elapsedMinutes(date: Date, now: number) {
  return Math.max(0, Math.round((now - date.getTime()) / 60000));
}

function formatAgo(date: Date, now = Date.now()) {
  const minutes = elapsedMinutes(date, now);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function MinuteRoll({ value }: { value: string }) {
  const prevRef = useRef(value);
  const [oldVal, setOldVal] = useState(value);
  const [newVal, setNewVal] = useState(value);
  const [rolling, setRolling] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [dir, setDir] = useState<"up" | "down">("up");

  useEffect(() => {
    if (prevRef.current === value) return;
    const from = prevRef.current;
    prevRef.current = value;
    const fromN = Number.parseInt(from, 10);
    const toN = Number.parseInt(value, 10);
    setDir(Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? "down" : "up");
    setOldVal(from);
    setNewVal(value);
    setRolling(true);
    setShifted(false);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true));
    });
    const done = window.setTimeout(() => {
      setRolling(false);
      setOldVal(value);
      setShifted(false);
    }, ROLL_MS);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(done);
    };
  }, [value]);

  const chars = rolling ? newVal : oldVal;

  return (
    <span className={styles.minRolls}>
      {Array.from({ length: chars.length }, (_, i) => {
        const previous = oldVal[i] ?? "";
        const next = chars[i] ?? "";
        if (!rolling || previous === next) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 逐位翻滚动画按字符位置渲染
            <span key={`${i}-${next}`} className={styles.minStatic}>
              {next}
            </span>
          );
        }
        const top = dir === "down" ? next : previous;
        const bottom = dir === "down" ? previous : next;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 逐位翻滚动画按字符位置渲染
          <span key={`${i}-${previous}-${next}-${dir}`} className={styles.minRoll}>
            <span
              className={styles.minRollInner}
              data-dir={dir}
              data-shifted={shifted ? "true" : undefined}
            >
              <span>{top}</span>
              <span>{bottom}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

function formatAbsolute(date: Date) {
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MessageActions({
  text = "",
  sentAt,
  onCopy,
  onVote,
  onReply,
  onFork,
  icons,
}: {
  text?: string;
  sentAt?: Date;
  onCopy?: (text: string) => void;
  onVote?: (vote: Vote) => void;
  onReply?: () => void;
  onFork?: () => void;
  icons?: Partial<MessageActionIcons>;
}) {
  const [vote, setVote] = useState<Vote>(null);
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  const [upN, setUpN] = useState(0);
  const [downN, setDownN] = useState(0);
  const [replyN, setReplyN] = useState(0);
  const icon = { ...messageActionIcons, ...icons };
  const Good = icon.good;
  const Bad = icon.bad;
  const Copy = icon.copy;
  const Copied = icon.copied;
  const Reply = icon.reply;
  const More = icon.more;
  const Aloud = icon.aloud;
  const Fork = icon.fork;
  const Report = icon.report;
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [postedAt] = useState(() => sentAt ?? new Date());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 900);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const choose = (next: Vote) => {
    const value = vote === next ? null : next;
    setVote(value);
    onVote?.(value);
    if (next === "up") setUpN((n) => n + 1);
    if (next === "down") setDownN((n) => n + 1);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 剪贴板不可用时仍展示已复制动画 */
    }
    setCopied(true);
    onCopy?.(text);
  };

  const reply = () => {
    setReplyN((n) => n + 1);
    setMenu(false);
    onReply?.();
  };

  const act = (action: "aloud" | "fork" | "report") => {
    if (action === "fork") onFork?.();
    setMenu(false);
  };

  return (
    <RowCues>
      <CueRoot rootRef={rootRef}>
        <Cue label="有帮助">
          <button
            type="button"
            className={styles.btn}
            data-on={vote === "up"}
            aria-pressed={vote === "up"}
            aria-label="有帮助"
            onClick={() => choose("up")}
          >
            <Good
              key={upN}
              className={`${styles.glyph} ${styles.voteUp} ${upN ? styles.bumpUp : ""}`}
              size={12}
            />
          </button>
        </Cue>

        <Cue label="需改进">
          <button
            type="button"
            className={styles.btn}
            data-on={vote === "down"}
            aria-pressed={vote === "down"}
            aria-label="需改进"
            onClick={() => choose("down")}
          >
            <Bad
              key={downN}
              className={`${styles.glyph} ${styles.glyphDown} ${styles.voteDown} ${downN ? styles.bumpDown : ""}`}
              size={12}
            />
          </button>
        </Cue>

        <Cue label={copied ? "已复制" : "复制"}>
          <button
            type="button"
            className={styles.btn}
            aria-label={copied ? "已复制" : "复制"}
            onClick={copy}
          >
            <span className={styles.copySwap} data-on={copied ? "true" : "false"}>
              <Copy className={`${styles.glyph} ${styles.copyMark}`} size={12} />
              <Copied className={`${styles.glyph} ${styles.check}`} size={12} />
            </span>
          </button>
        </Cue>

        <Cue label="引用回复">
          <button type="button" className={styles.btn} aria-label="引用回复" onClick={reply}>
            <Reply
              key={replyN}
              className={`${styles.glyph} ${styles.reply} ${replyN ? styles.replyPlay : ""}`}
              size={12}
            />
          </button>
        </Cue>

        <span className={styles.slot}>
          <Cue label="更多操作" quiet={menu}>
            <button
              type="button"
              className={styles.btn}
              data-on={menu}
              aria-expanded={menu}
              aria-controls={menuId}
              aria-haspopup="menu"
              aria-label="更多操作"
              onClick={() => setMenu((value) => !value)}
            >
              <More className={styles.glyph} size={12} />
            </button>
          </Cue>
          {menu ? (
            <div id={menuId} className={styles.menu} role="menu">
              <button
                type="button"
                className={styles.item}
                role="menuitem"
                onClick={() => act("aloud")}
              >
                <Aloud size={12} />
                朗读
              </button>
              <button
                type="button"
                className={styles.item}
                role="menuitem"
                onClick={() => act("fork")}
              >
                <Fork size={12} />
                分叉对话
              </button>
              <hr className={styles.rule} />
              <button
                type="button"
                className={`${styles.item} ${styles.danger}`}
                role="menuitem"
                onClick={() => act("report")}
              >
                <Report size={12} />
                举报
              </button>
            </div>
          ) : null}
        </span>

        <Cue label={formatAbsolute(postedAt)}>
          <time className={styles.ago} dateTime={postedAt.toISOString()}>
            {elapsedMinutes(postedAt, now) >= 1 && elapsedMinutes(postedAt, now) < 60 ? (
              <>
                <MinuteRoll value={String(elapsedMinutes(postedAt, now))} /> 分钟前
              </>
            ) : (
              formatAgo(postedAt, now)
            )}
          </time>
        </Cue>
      </CueRoot>
    </RowCues>
  );
}
