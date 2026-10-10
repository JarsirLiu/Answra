import type { ModeAction, Panel } from "../../model";
import { ICON, ICON_STROKE } from "../../tokens";

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
          <button
            aria-label={action.label}
            aria-pressed={isChatEntry ? panel === "chat" : undefined}
            className={`feature-action${action.id === "screenshot" ? " feature-action--primary" : ""}${
              soon ? " feature-action--soon" : ""
            }${isChatEntry && panel === "chat" ? " is-active" : ""}`}
            disabled={soon}
            key={action.id}
            onClick={() => onAction(action)}
            title={action.hint ?? action.label}
            type="button"
          >
            <action.icon aria-hidden="true" size={ICON} strokeWidth={ICON_STROKE} />
          </button>
        );
      })}
    </div>
  );
}
