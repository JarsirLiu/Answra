/** CLI 模型目录端口：只描述当前端点的模型 ID 查询；不依赖 fs、Ink、argv 或具体 HTTP 实现。 */
export interface ModelCatalogInput {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export interface ModelCatalog {
  list(input: ModelCatalogInput): Promise<readonly string[]>;
}

export type ModelCatalogErrorCode = "timeout" | "http" | "invalid-response";

/** 模型目录的稳定错误；TUI 只展示 message，不依赖供应商响应体。 */
export class ModelCatalogError extends Error {
  constructor(
    readonly code: ModelCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelCatalogError";
  }
}
