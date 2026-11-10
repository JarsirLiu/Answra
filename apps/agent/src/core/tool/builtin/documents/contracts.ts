/** Read 工具支持的文档格式与抽取结果契约；不读写文件系统。 */

/** PDF、旧版 Word（OLE）和 OpenXML Word 三种可抽取格式。 */
export type ReadableDocumentFormat = "pdf" | "doc" | "docx";

/** 文档抽取后的模型可见事实；正文以外的限制通过 notices 显式告知。 */
export interface ReadDocumentMetadata {
  readonly format: ReadableDocumentFormat;
  /** PDF 页数；Word 文档没有页概念，缺省。 */
  readonly pageCount?: number;
  /** 没有可提取文本的 PDF 页数。 */
  readonly emptyPageCount?: number;
  readonly notices: readonly string[];
}
