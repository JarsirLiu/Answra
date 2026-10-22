# Note：面试语音采集拒绝时区分音频来源

状态：已实施

## 问题

用户点击“开始采集”后系统声音捕获被拒绝。最初界面无法区分麦克风和系统声音；补充来源级提示及 main 日志后，实机日志显示 Electron 对该次系统声音请求调用了 `permission: "media"` handler，调用来自受信主 frame 且采集正在启动。旧日志只记录了 `audioOnly: false`，未输出原始 `mediaTypes`，因此无法确认具体数组；当前唯一 display 请求 `getDisplayMedia({ audio: true, video: true })` 会要求视频捕获授权。

## 涉及范围

- 代码/模块：`apps/desktop/src/renderer/interviewAudioCapture.ts`、`apps/desktop/src/main/interview/interviewIpc.ts` 及对应测试。
- UI/进程/协议/持久化表面：采集失败提示和 main 进程诊断日志；不改变权限授权范围与音频协议。
- 相关 Note：[实时语音人工试用闭环](../feature/2026-10-22-live-audio-test-loop.md)。

## 根因

Renderer 把两个采集 Promise 的拒绝映射成同一句提示，掩盖了来源。更深层的权限策略只授权纯音频麦克风请求，不授权 Electron display capture 所需的视频媒体权限，导致 `getDisplayMedia` 被拒绝。日志中的 `trustedMainFrame: true` 和 `captureStarting: true` 证明拒绝发生在受信主窗口的活动采集启动期。Electron API 还说明 permission check 与 permission request handler 应成对实现；原实现缺少前者。

## 决定

- 在处理每路采集 Promise 时保留 `interviewer`/`candidate` 来源，按权限拒绝、设备缺失和设备不可读分别生成对应提示。
- 受信主 frame 在采集启动期间可单次申请包含 `video` 或没有有效类型信息（字段缺失或空数组）的 `media` permission，以匹配 Electron 29 的实际请求形态；纯麦克风音频 permission check 仅对启动中的主 frame 放行。系统 display handler 仍要求活动会话及用户手势，并只返回固定显示器的 loopback 流。重复或采集期外的视频权限请求拒绝。
- main 对拒绝 display-media 请求、无可用屏幕来源和 `getSources` 异常记录来源明确的诊断信息；不记录音频内容。
- 保持原有受信主 frame、活动采集会话和 Windows 平台授权约束。

## 修复

- Renderer 对应提示现在能明确指出麦克风或系统声音捕获失败，并为麦克风拒绝提示 Windows 麦克风隐私设置入口。
- main 实现 Electron 要求的 media permission check 与 request handler；权限请求只对启动中的可信主窗口单次放行包含 video 或没有有效媒体类型（缺失、空数组）的请求，其余拒绝路径记录具体拦截条件。
- `interviewAudioCapture.test.ts` 覆盖两种权限拒绝的独立提示及失败后的轨道清理。

## 影响表面

- 用户可以按提示检查麦克风隐私设置，或重新发起系统声音捕获。
- 若系统声音请求仍失败，开发进程日志会指出权限条件、活动采集会话或来源枚举失败。
- 本修复不改变 OS 级麦克风授权，也不证明真实 loopback 已在目标设备工作。

## 曾考虑的替代方案

- **继续使用一条合并的权限提示：** 舍弃。双路并行请求让用户无法判断该检查哪项 Windows 权限，也无法向开发者报告可操作的信息。
- **仅记录 main 进程日志：** 舍弃。麦克风拒绝发生在 `getUserMedia` 时，main 的 display-media handler 不一定收到该错误；renderer 必须保留来源并反馈给用户。

## 后果与防回退

- 新增的来源级失败测试锁定“麦克风拒绝”和“系统声音拒绝”不能回退为同一个模糊提示。
- Electron 29.4.6 的 Windows 实机日志确认 display capture 对应的 `media` permission 请求会带 `mediaTypes: []`；该形态现在由单次授权路径覆盖。真实 loopback 音频是否可用仍需用户重新启动后试用确认。

## 验证

- `pnpm --filter @answra/desktop exec vitest run test/interviewIpc.test.ts test/interviewCaptureService.test.ts test/interviewAudioCapture.test.ts`：3 个文件、9 项通过；覆盖 permission check、视频请求单次授权、来源区分与生命周期。
- `pnpm verify`：一次全量运行通过，Agent 85、UI 250、Desktop 286 项及架构检查通过。最终复核时，一次被 UI 5 秒超时中断（该 UI 用例单测通过），另一次遇到 Agent 并发快照测试失败（该用例单测重跑通过）；两个失败用例都与本次改动无关。
- 最终代码状态下 `pnpm --filter @answra/desktop exec vitest run test/interviewIpc.test.ts test/interviewCaptureService.test.ts test/interviewAudioCapture.test.ts`：9 项通过；`pnpm --filter @answra/desktop typecheck`、`pnpm lint`、`pnpm notes:check`、`git diff --check`：通过。
- `pnpm notes:check`、`git diff --check`：通过。
- Windows 10.0.26200、Electron 29.4.6：点击采集时日志记录 `permission: "media"`、`trustedMainFrame: true`、`mediaTypes: []`、`captureStarting: true`，证明此前拒绝是空数组未被识别为未知媒体类型；修复后 loopback 实际音频仍待重新试用。
