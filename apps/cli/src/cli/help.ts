/** `answra --help` 的稳定文案；只描述当前已实现的 CLI 表面。 */
export const CLI_HELP = `Answra CLI

用法：
  answra code [选项] [prompt]
  answra --help
  answra --version

命令:
  code    启动独立 coding Bot 的编码会话；TTY 下进入交互 TUI

选项:
  --cwd <目录>          工作区根目录，默认当前目录
  --base-url <URL>      OpenAI 兼容端点，覆盖 ANSWRA_AI_BASE_URL
  --model <ID>          模型 ID，覆盖 ANSWRA_MODEL
  --api-key <KEY>       API Key，覆盖 ANSWRA_API_KEY；建议改用环境变量
  --no-alt-screen       不使用终端备用屏幕，保留主屏滚动记录
  -h, --help            显示帮助
  -v, --version         显示版本

环境变量:
  ANSWRA_AI_BASE_URL    OpenAI 兼容端点（与共享配置二选一）
  ANSWRA_MODEL          模型 ID（与共享配置二选一）
  ANSWRA_API_KEY        API Key（可留空；不读取桌面端加密密钥）

共享配置:
  未传 --base-url/--model 且环境变量为空时，读取桌面端「设置 → 模型」保存的本地模型配置。
  API Key 不共享；需要鉴权时请单独设置 ANSWRA_API_KEY 或 --api-key。

输入:
  提供 prompt 时作为单条消息发送并退出。
  TTY 下省略 prompt 进入全屏 TUI；非 TTY 从 stdin 读取全部内容。
  TUI: Enter 发送；运行中 Enter 排队；Shift+Enter 或 \\ + Enter 换行。
  Esc 取消当前运行；Ctrl-C 首次清空输入并提示，再次退出。
  Ctrl+O 展开/收起思考与工具输出；PgUp/PgDn 或滚轮滚动 transcript。
  Home/End 只移动输入光标；Up/Down 浏览输入历史。
  全屏下滚轮/鼠标由 TUI 接管；复制请用终端原生选择（必要时按住 Shift）。
  本地命令: /help、/clear、/exit（/quit 同义）。

说明:
  会话只保存在内存中，进程退出后不恢复。
`;
