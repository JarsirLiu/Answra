/** 模型设置领域错误：命令层据此区分“未配置”与真正的配置损坏。 */
export class MissingModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingModelConfigError";
  }
}
