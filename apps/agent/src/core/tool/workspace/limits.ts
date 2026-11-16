/** 文件工具共享的字节上限；读取与编辑各自声明预算，避免散落魔法值。 */

export const READ_FILE_MAX_BYTES = 256 * 1024;
/** 带 offset/limit 的 Read 仍需避免无界读取；超过上限时明确失败。 */
export const READ_SCAN_MAX_BYTES = 16 * 1024 * 1024;
export const EDIT_FILE_MAX_BYTES = 1024 * 1024;
