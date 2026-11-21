/** 可注入时钟；测试用 fake 控制超时和重连窗口。 */
export interface Clock {
  now(): number;
}
