/** 交接任务文本策略；与 Bot 目录、发现关系分开。 */
export const MAX_HANDOFF_TASK_CHARS = 32_000;

export function assertHandoffTask(task: string): void {
  if (!task.trim() || task.length > MAX_HANDOFF_TASK_CHARS) throw new Error("交接内容无效或过长");
}
