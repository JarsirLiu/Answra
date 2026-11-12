/** `answra --help` 的稳定文案；只描述当前已实现的 CLI 表面。 */
export const CLI_HELP = `Answra CLI

用法：
  answra code [选项] [prompt]
  answra --help
  answra --version

命令：
  code    启动独立 coding Bot 的一次性编码会话

选项：
  --cwd <目录>        工作区根目录，默认当前目录
  --base-url <URL>    OpenAI 兼容端点，覆盖 ANSWRA_AI_BASE_URL
  --model <ID>        模型 ID，覆盖 ANSWRA_MODEL
  --api-key <KEY>     API Key，覆盖 ANSWRA_API_KEY；建议改用环境变量
  -h, --help          显示帮助
  -v, --version       显示版本

环境变量：
  ANSWRA_AI_BASE_URL  OpenAI 兼容端点（必填）
  ANSWRA_MODEL        模型 ID（必填）
  ANSWRA_API_KEY      API Key（可留空）

输入：
  提供 prompt 时作为单条消息发送；否则从非 TTY stdin 读取全部内容。
  当前版本尚未接入 TUI，TTY 下请显式传入 prompt 或使用管道。

说明：
  会话只保存在内存中，进程退出后不恢复。
`;
