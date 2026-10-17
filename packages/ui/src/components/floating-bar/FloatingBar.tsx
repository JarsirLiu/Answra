import { useRef } from "react";
import { useDismissableOpen } from "../../hooks/useDismissableOpen";
import type { Mode, ModeAction, ModeDefinition, Panel } from "../../model";
import { FeatureActions } from "./FeatureActions";
import "./FloatingBar.css";
import { ModeMenu, ModePicker } from "./ModePicker";
import { WorkspaceControls } from "./WorkspaceControls";

interface FloatingBarProps {
  modes: readonly ModeDefinition[];
  mode: Mode;
  panel: Panel;
  modeMenuOpen: boolean;
  onModeChange: (mode: Mode) => void;
  onToggleModeMenu: () => void;
  onDismissModeMenu: () => void;
  onModeAction: (action: ModeAction) => void;
  onTogglePanel: (panel: Exclude<Panel, "closed">) => void;
  onClose: () => void;
}

/**
 * 悬浮导航条：模式 | 模式功能 | 工作区 三段结构。
 * 模式菜单绝对定位锚定在胶囊下方：面板打开时它直接盖在面板上（不挤压面板，
 * 面板也不会因此移位——窗口高度由面板决定，菜单永远比面板矮）；
 * 只有面板关闭、窗口高度只剩胶囊时才为菜单预留高度，否则菜单会被窗口裁掉。
 */
export function FloatingBar({
  modes,
  mode,
  panel,
  modeMenuOpen,
  onModeChange,
  onToggleModeMenu,
  onDismissModeMenu,
  onModeAction,
  onTogglePanel,
  onClose,
}: FloatingBarProps) {
  const stackRef = useRef<HTMLDivElement>(null);
  useDismissableOpen(stackRef, modeMenuOpen, onDismissModeMenu);

  const activeMode = modes.find((item) => item.id === mode) ?? modes[0];
  if (!activeMode) return null;

  const reserveMenuSpace = modeMenuOpen && panel === "closed";

  return (
    <div className={`floating-bar-stack${reserveMenuSpace ? " is-menu-open" : ""}`} ref={stackRef}>
      <section aria-label="悬浮导航" className="floating-bar floating-surface">
        <div className="nav-segment mode-segment">
          <ModePicker mode={mode} modes={modes} onToggle={onToggleModeMenu} open={modeMenuOpen} />
        </div>
        <span aria-hidden="true" className="segment-divider" />
        <div className="nav-segment feature-segment">
          <FeatureActions actions={activeMode.actions} onAction={onModeAction} panel={panel} />
        </div>
        <span aria-hidden="true" className="segment-divider" />
        <div className="nav-segment utility-segment">
          <WorkspaceControls onClose={onClose} onTogglePanel={onTogglePanel} panel={panel} />
        </div>
      </section>
      {modeMenuOpen && (
        <ModeMenu
          mode={mode}
          modes={modes}
          onModeChange={(next) => {
            onModeChange(next);
            onDismissModeMenu();
          }}
        />
      )}
    </div>
  );
}
