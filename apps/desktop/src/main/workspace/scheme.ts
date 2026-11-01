import { protocol } from "electron";

/** Privileges for the workspace-only resource protocol, registered before app readiness. */
export const ANSWMRA_FILE_SCHEME = "answra-file";

export function registerWorkspaceSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ANSWMRA_FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}
