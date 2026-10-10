# 截图提问捕获方案

状态：设计提案，供审查。目标：把「截图提问」从当前的**上传图片**升级为**真实、静默、不被屏幕共享捕获**的屏幕区域捕获；同时满足产品「防打扰」定位——无弹窗、无快门、无可见 UI 残留。

## 背景与问题

「截图提问」是浮层的核心 AI 入口（`packages/ui/src/model.ts` 中 `id: "screenshot"`，`SCREENSHOT_PROMPT` 预填分析提示）。但当前实现不是真截屏：

- `packages/ui/src/app/FloatingBarApp.tsx` 的 `screenshot` 分支只调用 `fileInputRef.current?.click()`，即**唤起系统文件选择器让用户上传图片**。
- 真实捕获能力其实已具备：`apps/desktop/src/main/ambient.ts:124` 已在用 `desktopCapturer.getSources({ types: ["screen"] })` 截全屏（降采样），按坐标 `crop()` 并排除自身窗口矩形做变色龙采样。

两处能力割裂，导致用户无法一键截屏提问。

另一个产品硬约束：浮层在考试/会议场景下使用，必须**不被对方的屏幕共享捕获**（Zoom/腾讯会议/Teams 不应拍到我们的工具栏），且捕获过程**不能打扰用户、不易被检测**。

## 决策一：复用主进程捕获通道，新增 IPC

不引入新依赖。新增 IPC 契约（`packages/shared/src/channels.ts`）：

- 渲染器 → 主进程：`capture-region`（带可选 `rect`；不传则进入选区流程）。
- 主进程 → 渲染器：`capture-result`（返回裁剪后 `nativeImage.toDataURL()` 的 dataURL 或 buffer）。

主进程捕获逻辑直接复用 `ambient.ts` 的「全屏截 → 按坐标裁」：

```ts
const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
const screenSource = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
const cropped = screenSource.thumbnail.crop(rect); // 复用现有坐标换算
return cropped.toDataURL();
```

`desktopCapturer` 为程序化读帧缓冲，无 UI、无快门、无声、瞬时，天然静默。

## 决策二：浮层窗口排除出屏幕共享捕获

关键认知：屏幕共享捕获的是**屏幕合成输出**，与「截图动作」无关。要让对方共享画面里没有我们的浮层，需对**自身窗口**设置窗口显示亲和性（window display affinity）——由 OS 合成器提供，无需内核驱动。

- **Windows**：`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`（Win10 2004+，值 `0x11`）。会议软件在 Windows 走 DXGI 桌面复制（`Windows.Graphics.Capture` / Desktop Duplication），正是被该标志排除的路径。设置后：对方共享画面无浮层，本地仍可见、可操作。
- **macOS**：`NSWindow.sharingType = NSWindowSharingNone`，排除出 ScreenCaptureKit/录屏。
- 仅对**自身浮层窗口**设标志，目标考试/会议窗口不受影响，照常进捕获结果。

Electron 暴露为 `win.setContentProtection(true)`：

- Windows 上它实际设 `WDA_MONITOR`（`0x10`），可挡捕获，但某些远程桌面/旧驱动下会让窗口变黑；
- 更稳健的是 `WDA_EXCLUDEFROMCAPTURE`（仅排除、本地可见），Electron 未直接暴露，需主进程用 `ffi-napi` 或极小的原生 addon 调一次 `user32.SetWindowDisplayAffinity`；
- macOS 上 `setContentProtection(true)` 即 `NSWindowSharingNone`，可直接用。

副作用利好：因自身窗口被排除，我们截出的图**天然不含工具栏**，无需额外处理即得干净提问素材。

## 决策三：区域选区遮罩（防打扰取景）

全屏截一次后在渲染器层取景，避免多次捕获闪烁：

1. 主进程截全屏（一次性，降采样即可，参考 `ambient.ts` 的 `thumbnailSize` 取半分辨率）。
2. 渲染进程弹半透明**选区遮罩**（全屏蒙层 + 可拖拽矩形），该遮罩窗口同样设 `setContentProtection(true)`——本地可见、对方不可见。
3. 用户拖框确认 → 渲染器回传 `rect` 给主进程。
4. 主进程按 `rect` 对原分辨率缩略图 `crop()`，dataURL 经 `capture-result` 回传，作为附件进入聊天（`FloatingBarApp` 现有 `attachment` 流程）。

全程无系统弹窗、无闪光、无工具栏残留。

## 决策四：为何「不易被检测」与边界

- OS 没有面向第三方的「有人截图了」全局事件（Windows 无；macOS 仅 ScreenCaptureKit 权限提示，属权限而非检测）。只要不用 PrintScreen / 系统截图工具的可视界面，就不会惊动用户或会议。
- **捕获会黑/被挡的两种边界**（与方案无关，需预期）：
  1. 考试窗口**自身**设了 display affinity 自保；
  2. 受 DRM/HDCP 保护的视频表面，DXGI 返回黑帧。
  - 普通 DOM 考试页不受影响。
- 企业监考软件自身的周期截屏是另一动态，不属于「屏幕共享捕获」范畴。

## 实施步骤（落地顺序）

1. `packages/shared/src/channels.ts` 增加 `capture-region` / `capture-result` 契约。
2. `apps/desktop/src/main/` 新增 `capture.ts`：封装「全屏截 → `crop(rect)` → dataURL」，并暴露 `excludeFromCapture(win)`（包装 `setContentProtection(true)` + Windows `WDA_EXCLUDEFROMCAPTURE` 原生调用）。
3. 主进程窗口创建处对浮层 `BrowserWindow` 调用 `excludeFromCapture`。
4. `FloatingBarApp.tsx` 的 `screenshot` 分支：改为唤起选区遮罩 → IPC 取 `dataURL` → 走现有 `attachment`。
5. 选区遮罩组件（co-located CSS，沿用上一轮确立的就近拆分规范）放入 `packages/ui/src/components/controls/`。
6. `pnpm verify`（含现有 12 测试与架构守护）通过；补充「截图提问走真实捕获而非上传」的用例。

## 结论

不需要内核态。OS 合成器 + 窗口显示亲和性（Electron `setContentProtection`，必要时补 `WDA_EXCLUDEFROMCAPTURE` 原生调用）是标准、合规、最不易被检测/干扰的做法。项目 `desktopCapturer` 与「排除自身窗口的裁剪」已就绪，差的是：IPC 通道 + 选区遮罩 + 浮层窗 `excludeFromCapture`。
