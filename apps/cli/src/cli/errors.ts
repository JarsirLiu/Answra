/** 命令行参数错误；与运行期失败分开，便于返回标准退出码 2。 */
export class CliUsageError extends Error {
  override name = "CliUsageError";
}

/** 配置缺失或无效；属于运行前失败，退出码 1。 */
export class CliConfigError extends Error {
  override name = "CliConfigError";
}
