import type { ReactNode } from "react";
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
  /**
   * 功能槽占用态：提供时，导航条右侧（模式功能段 + 工作区段）整体替换为该内容，
   * 只保留左侧模式选择。用于回复工作流等需要就地接管功能区的场景。
   */
  featureSlot?: ReactNode;
}

/**
 * 悬浮导航条：模式 | 模式功能 | 工作区 三段结构。
 * 模式菜单锚定在胶囊下方：面板打开时绝对定位覆盖面板；面板关闭时菜单进入正常布局流，
 * 让只有浮条的窗口按实际菜单高度扩展，避免菜单被窗口裁切。
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
  featureSlot,
}: FloatingBarProps) {
  const stackRef = useRef<HTMLDivElement>(null);
  useDismissableOpen(stackRef, modeMenuOpen, onDismissModeMenu);

  const activeMode = modes.find((item) => item.id === mode) ?? modes[0];
  if (!activeMode) return null;

  return (
    <div
      className={`floating-bar-stack${modeMenuOpen && panel === "closed" ? " is-menu-in-flow" : ""}`}
      ref={stackRef}
    >
      <section aria-label="悬浮导航" className="floating-bar floating-surface">
        <div className="nav-segment mode-segment">
          <ModePicker mode={mode} modes={modes} onToggle={onToggleModeMenu} open={modeMenuOpen} />
        </div>
        <span aria-hidden="true" className="segment-divider" />
        {featureSlot ? (
          <div className="nav-segment feature-slot">{featureSlot}</div>
        ) : (
          <>
            <div className="nav-segment feature-segment">
              <FeatureActions actions={activeMode.actions} onAction={onModeAction} panel={panel} />
            </div>
            <span aria-hidden="true" className="segment-divider" />
            <div className="nav-segment utility-segment">
              <WorkspaceControls onClose={onClose} onTogglePanel={onTogglePanel} panel={panel} />
            </div>
          </>
        )}
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
