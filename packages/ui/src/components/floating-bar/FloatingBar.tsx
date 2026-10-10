import { useRef, useState } from "react";
import type { Mode, ModeAction, ModeDefinition, Panel } from "../../model";
import { useDismissableOpen } from "../../hooks/useDismissableOpen";
import { FeatureActions } from "./FeatureActions";
import { ModeMenu, ModePicker } from "./ModePicker";
import { WorkspaceControls } from "./WorkspaceControls";

interface FloatingBarProps {
  modes: readonly ModeDefinition[];
  mode: Mode;
  panel: Panel;
  onModeChange: (mode: Mode) => void;
  onModeAction: (action: ModeAction) => void;
  onTogglePanel: (panel: Exclude<Panel, "closed">) => void;
  onClose: () => void;
}

/**
 * 悬浮导航条：模式 | 模式功能 | 工作区 三段结构。
 * 模式菜单渲染在胶囊下方的文档流中，菜单打开时外壳
 * 经 useFitContent 上报尺寸、窗口自动向下扩展。
 */
export function FloatingBar({
  modes,
  mode,
  panel,
  onModeChange,
  onModeAction,
  onTogglePanel,
  onClose,
}: FloatingBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const stackRef = useRef<HTMLDivElement>(null);
  useDismissableOpen(stackRef, menuOpen, () => setMenuOpen(false));

  const activeMode = modes.find((item) => item.id === mode) ?? modes[0];
  if (!activeMode) return null;

  return (
    <div className="floating-bar-stack" ref={stackRef}>
      <section aria-label="悬浮导航" className="floating-bar">
        <div className="nav-segment mode-segment">
          <ModePicker
            mode={mode}
            modes={modes}
            onToggle={() => setMenuOpen((open) => !open)}
            open={menuOpen}
          />
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
      {menuOpen && (
        <ModeMenu
          mode={mode}
          modes={modes}
          onModeChange={(next) => {
            onModeChange(next);
            setMenuOpen(false);
          }}
        />
      )}
    </div>
  );
}
