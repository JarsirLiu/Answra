import { BookOpen, FolderOpen, Settings, X } from "lucide-react";
import type { Panel } from "../../model";
import { ICON, ICON_SM, ICON_STROKE } from "../../tokens";
import { ChevronDownGlyph } from "../icons";

interface WorkspaceControlsProps {
  panel: Panel;
  onTogglePanel: (panel: Exclude<Panel, "closed">) => void;
  onClose: () => void;
}

/** 第三段：跨模式通用的工作区入口与应用控制。 */
export function WorkspaceControls({ panel, onTogglePanel, onClose }: WorkspaceControlsProps) {
  return (
    <>
      <button
        aria-label="打开笔记本"
        className={`utility-action utility-action--destination${panel === "notes" ? " is-active" : ""}`}
        onClick={() => onTogglePanel("notes")}
        title="笔记本"
        type="button"
      >
        <FolderOpen aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
        <span className="destination-label">
          <small>记录到</small>
          <strong>笔记本</strong>
        </span>
        <ChevronDownGlyph className="destination-chevron" />
      </button>
      <button
        aria-label="打开参考资料"
        className={`utility-action utility-action--icon${panel === "sources" ? " is-active" : ""}`}
        onClick={() => onTogglePanel("sources")}
        title="参考资料"
        type="button"
      >
        <BookOpen aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
      </button>
      <button
        aria-label="打开设置"
        className={`utility-action utility-action--icon${panel === "settings" ? " is-active" : ""}`}
        onClick={() => onTogglePanel("settings")}
        title="设置"
        type="button"
      >
        <Settings aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
      </button>
      <button
        aria-label="关闭应用"
        className="utility-action utility-action--close"
        onClick={onClose}
        title="关闭应用"
        type="button"
      >
        <X aria-hidden="true" size={ICON_SM} strokeWidth={ICON_STROKE} />
      </button>
    </>
  );
}
