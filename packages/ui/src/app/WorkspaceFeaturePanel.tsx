import type { DesktopBridge } from "@answra/shared";
import { WorkspacePanel } from "../components/panels/workspace/WorkspacePanel";

interface WorkspaceFeaturePanelProps {
  bridge: DesktopBridge | undefined;
  stealth: boolean;
  onClose: () => void;
}

/** Workspace-only renderer composition, loaded only by profiles that include the feature. */
export function WorkspaceFeaturePanel({ bridge, stealth, onClose }: WorkspaceFeaturePanelProps) {
  return <WorkspacePanel bridge={bridge} stealth={stealth} onClose={onClose} />;
}
