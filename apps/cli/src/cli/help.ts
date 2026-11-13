/** `answra --help` 的稳定文案；只描述当前已实现的 CLI 表面。 */
export const CLI_HELP = `Answra CLI

用法：
  answra code [选项] [prompt]
  answra config show
  answra config set --base-url <URL> --model <ID> [--answer-model <ID>] [--api-key <KEY>]
  answra config unset
  answra auth <login|status|logout>
  answra remote host [--key-id <keyId>] [--cwd <目录>]
  answra remote attach [--no-alt-screen]
  answra remote key <create|list|revoke|set|show|forget>
  answra --help
  answra --version

命令:
  code     启动独立 coding Bot 的编码会话；TTY 下进入交互 TUI
  config   查看或保存桌面端与 CLI 共享的本地模型配置
  auth     登录 Answra 账号；远程 host/attach 的服务准入凭据
  remote   启动远程 host、连接 controller 或管理访问密钥；运行 answra remote --help 查看详情

code 选项:
  --cwd <目录>          工作区根目录，默认当前目录
  --base-url <URL>      OpenAI 兼容端点，覆盖 ANSWRA_AI_BASE_URL
  --model <ID>          模型 ID，覆盖 ANSWRA_MODEL
  --api-key <KEY>       API Key，覆盖环境变量与系统凭据库；不写入配置文件
  --no-alt-screen       不使用终端备用屏幕，保留主屏滚动记录
  -h, --help            显示帮助
  -v, --version         显示版本

环境变量:
  ANSWRA_AI_BASE_URL    OpenAI 兼容端点（与共享配置二选一）
  ANSWRA_MODEL          模型 ID（与共享配置二选一）
  ANSWRA_API_KEY        API Key（可留空；不写入共享配置）

共享配置:
  运行 answra config set 写入桌面端「设置 → 模型」使用的同一份本地模型配置；
  运行 answra config unset 只清除本地模型字段，不删除文件。
  未传 --base-url/--model 且环境变量为空时，读取该共享配置。
  API Key 存 OS keychain（Windows Credential Manager / macOS Keychain / Linux Secret Service），
  桌面端与 CLI 共用；可用 answra config set --api-key 或首次 TTY 引导写入。
  TUI 输入 API Key 后保存到系统凭据库；空输入沿用已保存的 Key。

账号登录:
  运行 answra auth login 打开 AnswraSite 授权页；把浏览器显示的 code#state 粘贴回终端。
  登录凭据只保存在 OS keychain；answra auth logout 撤销并删除本机登录态。
  远程 host/attach 需要登录；控制 host 还需要该 host 的远程访问密钥。

远程访问密钥:
  host 上运行 answra remote key create 生成，默认 7 天、只显示一次；
  controller 上运行 answra remote key set 粘贴并保存到本机；
  key list/show 只显示 keyId 与过期时间，不显示 secret；
  key revoke 撤销 host 密钥，key forget 删除本机 controller 密钥。

输入:
  提供 prompt 时作为单条消息发送并退出。
  TTY 下省略 prompt 进入全屏 TUI；非 TTY 从 stdin 读取全部内容。
  TUI: Enter 发送；运行中 Enter 排队；Shift+Enter 或 \\ + Enter 换行。
  Esc 取消当前运行；Ctrl-C 首次清空输入并提示，再次退出。
  Ctrl+O 展开/收起思考与工具输出；PgUp/PgDn 或滚轮滚动 transcript。
  Home/End 只移动输入光标；Up/Down 浏览输入历史。
  全屏下滚轮/鼠标由 TUI 接管；复制请用终端原生选择（必要时按住 Shift）。
  本地命令: /help、/clear、/config、/model、/exit（/quit 同义）。
  /config 打开模型配置面板；/model 打开模型选择器；/model <ID> 直接切换并保存。

说明:
  会话只保存在内存中，进程退出后不恢复。
`;
