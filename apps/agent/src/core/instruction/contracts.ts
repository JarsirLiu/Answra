/** AGENTS.md 指令上下文的唯一契约：文件、加载器与容量边界。 */

/** 从磁盘读取到的一条项目指令文件。 */
export interface InstructionFile {
  /** 实际读取的绝对路径，渲染进 system prompt 供模型追溯来源。 */
  readonly path: string;
  /** 文件原文；空文件也保留，表示该路径存在但未写内容。 */
  readonly content: string;
}

/** 按工作区加载 AGENTS.md；全局文件路径由宿主在创建时注入。 */
export interface InstructionLoader {
  load(workspaceRoot: string | null): Promise<readonly InstructionFile[]>;
}

/** 单个指令文件大小上限；超过直接跳过，避免异常大文件撑爆 system prompt。 */
export const INSTRUCTION_FILE_MAX_BYTES = 256_000;
