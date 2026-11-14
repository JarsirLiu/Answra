/** TUI 压缩边界投影：来源 conversation snapshot，只用于展示，不进入模型上下文。 */
export interface TuiCompactionBoundary {
  readonly id: string;
  /** 边界出现在这条消息之后；缺省表示出现在 transcript 开头。 */
  readonly afterMessageId?: string;
  /** 摘要正文；旧 snapshot 没有边界列表时缺省。 */
  readonly summary?: string;
  /** 截至该边界的累计摘要消息数。 */
  readonly summarizedMessages?: number;
  /** 本次手动压缩附带的一次性摘要指令。 */
  readonly instructions?: string;
}
