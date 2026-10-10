export { FloatingBarApp } from "./app/FloatingBarApp";
export { FeatureActions } from "./components/floating-bar/FeatureActions";
export { FloatingBar } from "./components/floating-bar/FloatingBar";
export { ModeMenu, ModePicker } from "./components/floating-bar/ModePicker";
export { WorkspaceControls } from "./components/floating-bar/WorkspaceControls";
export type { ChatAttachment, ChatMessage } from "./components/panels/ChatPanel";
export { PanelShell } from "./components/panels/PanelShell";
export { useDismissableOpen } from "./hooks/useDismissableOpen";
export type { Mode, ModeAction, ModeDefinition, Panel } from "./model";
export { MODES, NOTE_STORAGE_KEY, WELCOME_MESSAGE } from "./model";
export {
  COLOR_GROUPS,
  colorGroupTokens,
  loadColorGroups,
  saveColorGroups,
  useAppTheme,
  type ColorGroupId,
  type ColorGroupOverrides,
} from "./theme";
export { ICON, ICON_SM, ICON_STROKE } from "./tokens";
