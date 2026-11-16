# Note：Shell 输出保留合法的 UTF-8 替换字符

状态：已实施

## 问题

`decodeShellOutput` 先按 UTF-8 解码，只要结果包含 U+FFFD（`�`）就整体回退到 GBK。这个判断把「UTF-8 解码失败」和「UTF-8 内容本身包含 U+FFFD」混为一谈。

用户用 `git show` 读取旧 blob 时，blob 里真实存在 `EF BF BD` 字节。UTF-8 解码本身完全成功，但结果含 U+FFFD；旧逻辑误判为编码失败，随后把同一段合法 UTF-8 中文字节按 GBK 重新解释，返回 `鐘舵€` 一类损坏文本。只要命令输出中原本就有 U+FFFD，后续所有中文都会被破坏。

## 涉及范围

- `apps/agent/src/core/tool/builtin/shell/runtime.ts`：`decodeShellOutput` 的 UTF-8/GBK 判定。
- `apps/agent/test/core/tool/shell/runtime.test.ts`：合法 U+FFFD 与非法 UTF-8 的边界测试。
- 一次性 `RunCommand` 与可续接 `WriteStdin` 共用该函数，修复同时覆盖两条路径。

## 根因

- `decodeShellOutput` 用「解码结果是否包含 U+FFFD」判断 UTF-8 是否失败，而不是判断字节序列是否合法。
- 真实 U+FFFD 的字节序列 `EF BF BD` 本身是合法 UTF-8，因此被误判为 GBK 输出并整体重解码。
- 这不是编码探测的边界问题，而是失败信号选错：替换字符是合法的解码结果，不是解码失败的证明。

## 修复

- 字符串输入直接返回，不再做无意义的 Buffer 往返。
- 只对 Buffer 执行 `TextDecoder("utf-8", { fatal: true })`：成功即返回，失败才回退 GBK。
- 增加合法 U+FFFD 字节的回归测试，保留既有 GBK 用例。

## 决定

- 字符串输入已经是解码后的文本，直接原样返回，不再经 Buffer 往返。
- Buffer 输入使用 `TextDecoder("utf-8", { fatal: true })` 判断是否为合法 UTF-8：
  - 解码成功：返回结果，即使内容包含 U+FFFD；
  - 抛出 `TypeError`：说明字节序列不是合法 UTF-8，才回退 `TextDecoder("gbk")`。
- 不回退到「出现替换字符就猜 GBK」。U+FFFD 是合法的 Unicode 字符，不能作为编码失败信号。
- 保留现有 GBK 回退，因为 Windows 中文环境的原生命令仍可能输出代码页 936 字节。

## 曾考虑的替代方案

- **继续扫描 U+FFFD，但增加比例阈值：** 舍弃。合法与非法内容都可能出现任意数量的 U+FFFD，阈值只能把误判变成概率问题。
- **完全移除 GBK 回退：** 舍弃。会破坏当前 Windows 中文原生命令输出。
- **引入 `iconv-lite` 或自动编码探测：** 舍弃。现有依赖边界不引入新包；`fatal` 解码已能准确回答「这段字节是不是合法 UTF-8」。
- **仅在 PowerShell stderr 上启用严格 UTF-8：** 舍弃。`git show` 等原生命令的 stdout 同样会输出真实 U+FFFD，问题不局限于 stderr。

## 后果与防回退

- 真 U+FFFD 与非法 UTF-8 现在走不同分支，不再互相污染。
- GBK 回退范围收窄为「UTF-8 严格解码失败」，这是比替换字符扫描更可靠的判据。
- 防回退测试必须同时覆盖：
  - 合法 UTF-8 文本中包含真实 `EF BF BD` 时原样保留；
  - 非 UTF-8 的 GBK 字节仍能解码为中文；
  - 普通 UTF-8 中英文输出不变。
- 已知限制：可续接 shell 会话若在输出末尾截断一个多字节 UTF-8 字符，下一段从延续字节开始时仍可能被严格解码判为非法。该问题来自按字节偏移切片，不是本次判定逻辑引入；若要彻底解决，需要在会话输出路径保留跨快照的解码状态，另行设计。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/tool/shell/runtime.test.ts`
- 回归用例：`Buffer.concat([Buffer.from("before "), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(" after 中文")])` 返回原文而非 GBK 乱码。
- 既有 GBK 用例继续通过。
