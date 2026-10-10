import type { Mode, ModeAction, ModeDefinition, Panel } from "../../model";
import { FeatureActions } from "./FeatureActions";
import { ModePicker } from "./ModePicker";
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

/** 悬浮导航条：模式 | 模式功能 | 工作区 三段结构。 */
export function FloatingBar({
  modes,
  mode,
  panel,
  onModeChange,
  onModeAction,
  onTogglePanel,
  onClose,
}: FloatingBarProps) {
  const activeMode = modes.find((item) => item.id === mode) ?? modes[0];
  if (!activeMode) return null;

  return (
    <section aria-label="悬浮导航" className="floating-bar">
      <div className="nav-segment mode-segment">
        <ModePicker modes={modes} mode={mode} onModeChange={onModeChange} />
      </div>
      <span aria-hidden="true" className="segment-divider" />
      <div className="nav-segment feature-segment">
        <FeatureActions actions={activeMode.actions} panel={panel} onAction={onModeAction} />
      </div>
      <span aria-hidden="true" className="segment-divider" />
      <div className="nav-segment utility-segment">
        <WorkspaceControls onClose={onClose} onTogglePanel={onTogglePanel} panel={panel} />
      </div>
    </section>
  );
}
