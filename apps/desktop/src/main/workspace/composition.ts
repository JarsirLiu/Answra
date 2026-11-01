import { getWindow, isStealthEnabled } from "../window";
import { registerWorkspaceFileProtocol } from "./fileProtocol";
import { registerWorkspaceIpc } from "./workspaceIpc";
import { WorkspaceService } from "./workspaceService";

/** Creates and owns every main-process resource required by the workspace feature. */
export function createWorkspaceComposition(configDir: string) {
  const service = new WorkspaceService({ configDir });
  registerWorkspaceFileProtocol(service);
  registerWorkspaceIpc(service, getWindow, isStealthEnabled);
  return {
    getRoot: () => service.getRoot(),
    restoreRoot: () => service.restoreRoot(),
    dispose: () => service.dispose(),
  };
}
