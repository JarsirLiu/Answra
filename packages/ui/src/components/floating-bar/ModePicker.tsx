import type { Mode, ModeDefinition } from "../../model";
import { ICON, ICON_SM, ICON_STROKE } from "../../tokens";
import { CheckGlyph, ChevronDownGlyph } from "../icons";
import "./ModePicker.css";

interface ModePickerProps {
  modes: readonly ModeDefinition[];
  mode: Mode;
  /** 菜单开关状态由 FloatingBar 持有：菜单渲染在胶囊下方的文档流里。 */
  open: boolean;
  onToggle: () => void;
}

/** 第一段：工作模式选择器（仅触发按钮；菜单由 FloatingBar 渲染在胶囊下方）。 */
export function ModePicker({ modes, mode, open, onToggle }: ModePickerProps) {
  const active = modes.find((item) => item.id === mode) ?? modes[0];
  if (!active) return null;
  const ActiveIcon = active.icon;

  return (
    <button
      aria-expanded={open}
      aria-haspopup="menu"
      className="mode-picker-trigger"
      onClick={onToggle}
      type="button"
    >
      <ActiveIcon aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
      <span>{active.label}</span>
      <ChevronDownGlyph className="mode-picker-chevron" />
    </button>
  );
}

/** 模式菜单列表；由 FloatingBar 渲染在胶囊下方，参与文档流。 */
export function ModeMenu({
  modes,
  mode,
  onModeChange,
}: {
  modes: readonly ModeDefinition[];
  mode: Mode;
  onModeChange: (mode: Mode) => void;
}) {
  return (
    <div aria-label="工作模式" className="mode-menu" role="menu">
      {modes.map((item) => (
        <button
          aria-checked={mode === item.id}
          className={`mode-menu-item${mode === item.id ? " is-active" : ""}`}
          key={item.id}
          onClick={() => onModeChange(item.id)}
          role="menuitemradio"
          type="button"
        >
          <item.icon aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
          <span>{item.label}</span>
          {mode === item.id && <CheckGlyph className="mode-menu-check" />}
        </button>
      ))}
    </div>
  );
}
