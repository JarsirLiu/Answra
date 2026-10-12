# Note：工作区目录分栏与 DOCX 预览修复

状态：已实施

## 问题

工作区目录树和右侧预览缺少清楚的分栏边界，目录宽度过大且不可收起，预览面积被压缩。DOCX 选择后页面仍按纸张原始宽度显示并发生裁切；此前还存在 JSZip 输入类型错误和加载/错误消息旁的空白宿主。

## 涉及范围

- 代码/模块：`packages/ui/src/components/panels/workspace/WorkspacePanel.css`、`DirectoryTree.css`、`DocxPreviewPane.tsx`
- UI/进程/协议/持久化表面：工作区左侧文件树和右侧文档预览
- 相关 Note：[工作区文件预览](../feature/2026-10-12-workspace-file-preview.md)、[工作区空状态与控件主题对齐](./2026-10-12-workspace-theme-alignment.md)

## 根因

左侧栏用百分比宽度且无分隔线；目录按钮允许文字压缩。DOCX 预览先创建 `JSZip` 实例再传给 `docx-preview`，但库的稳定 API 接收 `Blob`、`ArrayBuffer` 或 `Uint8Array`。另外，错误/加载状态和内容宿主作为两个 flex 子元素同时渲染。

## 决定

- 目录固定在较窄的左侧栏，以明确分隔线保持树形导航可扫描；可收起为图标栏，预览区使用释放出的宽度。
- `docx-preview.renderAsync` 接收解码后的 `Uint8Array` 文档字节，不再预加载/传递 `JSZip` 对象。
- 按 DOCX 页面的原始宽度和宿主可用宽度计算缩放比例，并在阅读区尺寸变化时重新适配；加载与错误状态独占可见预览区，解析宿主保持挂载但隐藏，成功后显示。
- 增加预览组件测试覆盖输入类型和状态显示。

## 修复

以 `docx-preview` README 中的稳定 API 签名作为输入契约，保留已有懒加载和文档分页渲染选项；分栏样式以全局主题描边令牌绘制边界，目录折叠状态仅在当前面板生命周期内保存。

## 影响表面

工作区窄面板的树/预览宽度分配、文件树新建操作和 DOCX 解析流程。

## 曾考虑的替代方案

- **保留 JSZip 并转换为 Blob：** 多一次解压/重新包装且无收益，库本身通过 JSZip 解析原始字节，舍弃。
- **保留白色文档预览卡片并仅放大错误文字：** 错误时仍留下与空状态无关的白块，且分页页面已经由预览库自行绘制纸张，舍弃。

## 验收标准

- 可观察结果：目录位于左侧、宽度较小且可收起；DOCX 页面适配可用阅读宽度；加载和解析错误状态占据完整预览区域，不出现并排空白框。
- 自动化验证：`packages/ui/test/workspace.test.tsx` 验证目录折叠、预览接收字节和状态布局；运行 `pnpm notes:check` 和 `pnpm verify`。
- 需要的实机验证：Windows 桌面窗口打开真实 DOCX，核对分页、表格与中文文档排版。

## 后果与防回退

DOCX 输入格式直接跟随 `docx-preview` 公共稳定 API；预览宿主解析期间需挂载但隐藏，加载或错误提示应独占可见区域。视口宽度变化必须重新测量页面，保持页面完整可见。

## 验证

`pnpm --filter @answra/ui test -- workspace.test.tsx`、`pnpm notes:check`、`pnpm verify` 均通过。
