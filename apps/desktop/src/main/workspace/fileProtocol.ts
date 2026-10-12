import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import type { WorkspaceService } from "./workspaceService";

/**
 * answra-file:// 自定义协议：渲染进程经此加载工作区内本地资源
 * （md 预览中的图片、pdf 等），不使用裸 file://，也不暴露工作区外路径。
 *
 * URL 形式：`answra-file:///<相对路径>`（相对工作区根目录）。
 * scheme 权限必须在 app ready 前（registerSchemesAsPrivileged）声明，
 * 见 index.ts；handler 在 ready 后（registerFileProtocol）注册。
 */

export const ANSWMRA_FILE_SCHEME = "answra-file";

export function registerWorkspaceSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ANSWMRA_FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

export function registerWorkspaceFileProtocol(service: WorkspaceService): void {
  protocol.handle(ANSWMRA_FILE_SCHEME, async (request) => {
    try {
      const raw = new URL(request.url);
      const relPath = decodeURIComponent(raw.pathname).replace(/^\/+/, "");
      const absolute = service.resolve(relPath);
      return await net.fetch(pathToFileURL(absolute).toString());
    } catch (error) {
      return new Response(`workspace resource unavailable: ${String(error)}`, { status: 404 });
    }
  });
}
