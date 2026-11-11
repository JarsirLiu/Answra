import type { ModeAction, Panel } from "../../model";
import { IconButton } from "../controls/IconButton";
import "./FeatureActions.css";

interface FeatureActionsProps {
  actions: readonly ModeAction[];
  /** 当前打开的面板，用于「AI 对话」等入口的激活态。 */
  panel: Panel;
  onAction: (action: ModeAction) => void;
}

/** 第二段：当前模式的功能入口。 */
export function FeatureActions({ actions, panel, onAction }: FeatureActionsProps) {
  return (
    <div className="feature-actions">
      {actions.map((action) => {
        const isChatEntry = action.id === "chat";
        const soon = action.disabled === true;
        return (
          <IconButton
            aria-pressed={isChatEntry ? panel === "chat" : undefined}
            className={`feature-action${soon ? " feature-action--soon" : ""}${
              isChatEntry && panel === "chat" ? " is-active" : ""
            }`}
            disabled={soon}
            icon={action.icon}
            key={action.id}
            label={action.label}
            onClick={() => onAction(action)}
          />
        );
      })}
    </div>
  );
}
