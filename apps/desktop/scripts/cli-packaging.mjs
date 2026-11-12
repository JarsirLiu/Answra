/** 桌面安装包中的 CLI 资源与 Windows shim；不新增独立可执行文件。 */
export const CLI_RESOURCE = Object.freeze({
  from: "../cli/dist",
  to: "cli",
  filter: ["**/*"],
});

export const WINDOWS_CLI_SHIM = Object.freeze({
  from: "resources/cli/answra.cmd",
  to: "answra.cmd",
});

export function applyCliPackaging(config) {
  config.extraResources = [...(config.extraResources ?? []), CLI_RESOURCE];
  config.extraFiles = [...(config.extraFiles ?? []), WINDOWS_CLI_SHIM];
}
