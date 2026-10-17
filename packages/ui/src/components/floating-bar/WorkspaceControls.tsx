import { FolderOpen, Settings, X } from "lucide-react";
import type { Panel } from "../../model";
import { ICON, ICON_STROKE } from "../../tokens";
import { SurfaceButton } from "../controls/SurfaceButton";
import { ChevronDownGlyph } from "../icons";
import "./WorkspaceControls.css";

interface WorkspaceControlsProps {
  panel: Panel;
  onTogglePanel: (panel: Exclude<Panel, "closed">) => void;
  onClose: () => void;
}

/**
 * 第三段：跨模式通用的工作区入口与应用控制。
 * 笔记本入口只保留一个：笔记与资料共用同一块工作区面板，
 * 不再为同一个目标提供两个并列入口。
 */
export function WorkspaceControls({ panel, onTogglePanel, onClose }: WorkspaceControlsProps) {
  return (
    <>
      <SurfaceButton
        aria-label="打开笔记本"
        className={`utility-action utility-action--destination${panel === "notes" ? " is-active" : ""}`}
        onClick={() => onTogglePanel("notes")}
        type="button"
      >
        <FolderOpen aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
        <span className="destination-label">
          <small>记录到</small>
          <strong>笔记本</strong>
        </span>
        <ChevronDownGlyph className="destination-chevron" />
      </SurfaceButton>
      <SurfaceButton
        aria-label="打开设置"
        className={`utility-action${panel === "settings" ? " is-active" : ""}`}
        onClick={() => onTogglePanel("settings")}
        type="button"
      >
        <Settings aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
      </SurfaceButton>
      <SurfaceButton
        aria-label="关闭应用"
        className="utility-action utility-action--close"
        onClick={onClose}
        type="button"
      >
        <X aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
      </SurfaceButton>
    </>
  );
}
