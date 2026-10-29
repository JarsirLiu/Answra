/** 本地工作区文件与目录操作的 IPC 频道和载荷契约。 */
/**
 * 本地工作区（合并笔记本与资料）频道。
 *
 * 所有路径参数均为相对根目录的 POSIX 风格路径（"/" 分隔）；
 * main 侧负责把相对路径解析为绝对路径并做根目录边界校验。
 */
export const WorkspaceChannels = {
  /** 读取缓存的上一工作区根目录（不存在或已失效时 root 为 null）。 */
  GetRoot: "answra:workspace:get-root",
  /** 弹出系统目录选择框；用户取消时 root 为 null。选择成功即缓存为新根目录。 */
  PickRoot: "answra:workspace:pick-root",
  /** 列出根目录下的完整目录树（目录在前、名称排序）。 */
  ListTree: "answra:workspace:list-tree",
  /** 读取文件：返回 base64 字节与 UTF-8 文本（二进制文件 text 为 null）。 */
  ReadFile: "answra:workspace:read-file",
  /** 以 UTF-8 写入文本文件（仅 md 等文本类型）。 */
  WriteFile: "answra:workspace:write-file",
  /** 写入二进制文件（仅图片类型，base64；用于粘贴截图落盘）。 */
  WriteBytes: "answra:workspace:write-bytes",
  /** 新建目录或空 md 文档（父目录自动创建；已存在时失败）。 */
  CreateEntry: "answra:workspace:create-entry",
  /** 删除文件或目录（目录递归删除）。 */
  DeleteEntry: "answra:workspace:delete-entry",
  /** 主进程 → 渲染进程推送根目录内变更（watcher 防抖合并后的相对路径列表）。 */
  Changed: "answra:workspace:changed",
} as const;

/** 工作区目录树节点；`path` 为相对根目录的 POSIX 风格路径，根目录本身不出现。 */
export interface WorkspaceNode {
  name: string;
  path: string;
  kind: "dir" | "file";
}

/** 工作区文件读取结果。 */
export interface WorkspaceFileContent {
  /** 媒体类型推断（png/jpeg/webp/gif/pdf/docx…，未知为 application/octet-stream）。 */
  mediaType: string;
  /** 原始字节（base64）。 */
  dataBase64: string;
  /** UTF-8 文本内容；二进制文件为 null。 */
  text: string | null;
}

export interface WorkspaceCreateRequest {
  path: string;
  kind: "dir" | "file";
}

/** 主进程推送的根目录内变更（相对路径，POSIX 分隔）。 */
export interface WorkspaceChangeSet {
  paths: string[];
}

export interface WorkspaceChannelMap {
  [WorkspaceChannels.GetRoot]: { request: undefined; response: { root: string | null } };
  [WorkspaceChannels.PickRoot]: { request: undefined; response: { root: string | null } };
  [WorkspaceChannels.ListTree]: { request: undefined; response: WorkspaceNode[] };
  [WorkspaceChannels.ReadFile]: {
    request: { path: string };
    response: WorkspaceFileContent;
  };
  [WorkspaceChannels.WriteFile]: { request: { path: string; text: string }; response: undefined };
  [WorkspaceChannels.WriteBytes]: {
    request: { path: string; dataBase64: string };
    response: undefined;
  };
  [WorkspaceChannels.CreateEntry]: {
    request: WorkspaceCreateRequest;
    response: undefined;
  };
  [WorkspaceChannels.DeleteEntry]: { request: { path: string }; response: undefined };
  [WorkspaceChannels.Changed]: { request: undefined; response: undefined };
}
