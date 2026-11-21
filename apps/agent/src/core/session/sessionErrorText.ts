/** Session 运行时的稳定错误文本投影；不解释错误，也不吞掉原异常。 */
export function sessionErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Session 执行失败";
}
