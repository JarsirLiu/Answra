import { useRef, useState } from "react";
import { useDismissableOpen } from "../../hooks/useDismissableOpen";
import type { Mode, ModeDefinition } from "../../model";
import { ICON, ICON_SM, ICON_STROKE } from "../../tokens";

interface ModePickerProps {
  modes: readonly ModeDefinition[];
  mode: Mode;
  onModeChange: (mode: Mode) => void;
}

/** 第一段：工作模式选择器（点击展开菜单，外点/Esc 关闭）。 */
export function ModePicker({ modes, mode, onModeChange }: ModePickerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissableOpen(containerRef, menuOpen, () => setMenuOpen(false));

  const active = modes.find((item) => item.id === mode) ?? modes[0];
  if (!active) return null;
  const ActiveIcon = active.icon;

  return (
    <div className="mode-picker" ref={containerRef}>
      <button
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        className="mode-picker-trigger"
        onClick={() => setMenuOpen((open) => !open)}
        title="切换工作模式"
        type="button"
      >
        <ActiveIcon aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
        <span>{active.label}</span>
        <span aria-hidden="true" className="mode-picker-chevron">
          ⌄
        </span>
      </button>
      {menuOpen && (
        <div aria-label="工作模式" className="mode-menu" role="menu">
          {modes.map((item) => (
            <button
              aria-checked={mode === item.id}
              className={`mode-menu-item${mode === item.id ? " is-active" : ""}`}
              key={item.id}
              onClick={() => {
                onModeChange(item.id);
                setMenuOpen(false);
              }}
              role="menuitemradio"
              type="button"
            >
              <item.icon aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
              <span>{item.label}</span>
              {mode === item.id && (
                <span aria-hidden="true" className="mode-menu-check">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
