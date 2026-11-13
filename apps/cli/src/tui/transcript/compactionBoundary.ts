/** TUI 压缩边界投影：来源 conversation snapshot，只用于展示，不进入模型上下文。 */
export interface TuiCompactionBoundary {
  readonly id: string;
  /** 边界出现在这条消息之后；缺省表示出现在 transcript 开头。 */
  readonly afterMessageId?: string;
}
