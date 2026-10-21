# Note：biome 排除 vendored 资源目录

状态：已实施

## 问题

`biome.json` 的 `files.includes` 用 `**` 作为默认包含，虽然 `vcs.useIgnoreFile: true` 会读 `.gitignore`，但对 `.gitignore` 忽略目录下的 vendored 产物（如 `apps/desktop/native/rime-data/weasel_upstream/**`、`apps/desktop/resources/rime/**`、`apps/desktop/resources/vad/**`、`apps/desktop/.cache-rime/**`、`apps/desktop/.cache-vad/**`）仍会逐文件 lint/格式化，产生大量无关的 formatter diff 与 lint 错误（`useTemplate`、`noDoubleEquals`、`noAssignInExpressions`、`noCommaOperator` 等），把门禁淹没在上游产物噪声里。这些产物本地才存在、不入 Git，本该与门禁无关。

## 涉及范围

- `biome.json`：`files.includes` 追加对 vendored 目录的排除项。
- 不涉及任何源码、运行时行为或产物内容。

## 影响表面

- `pnpm lint`（biome）的扫描面收窄到仓库源码；vendored/缓存产物不再参与 lint 与 format 检查。

## 流程变化

- `pnpm lint` 的输入集合改变：由"全目录扫描"变为"排除 vendored 目录后的源码扫描"。

## 决定

在 `biome.json` 的 `files.includes` 中，沿用既有 `!!apps/desktop/dist` 等条目的同形写法，追加 `!!apps/desktop/native`、`!!apps/desktop/.cache-rime`、`!!apps/desktop/.cache-vad`、`!!apps/desktop/resources/rime`、`!!apps/desktop/resources/vad`。排除依据是 AGENTS.md「内置输入法资源」与 VAD 资源的约定：这些目录的字节来自上游/预编译资源，不在仓库内维护，永不参与 lint。

## 曾考虑的替代方案

- **只加 `.gitignore` 项，不改 biome**：这些路径本来就已 gitignore，问题恰恰是 biome 的 `includes: **` 覆盖了 gitignore 语义；追加 ignore 无效，舍弃。
- **把 `includes: **` 换成逐目录白名单**：正确但改动面大、易漏新目录，维护成本高于收益，舍弃。
- **给这些文件加 `// biome-ignore` 逐行抑制**：对压缩产物逐行加注不现实，且把 vendored 内容写进仓库，舍弃。

## 后果与防回退

- vendored 产物若混入真实源码文件，biome 也不再能发现其中问题；这些目录的内容变更只能靠上游来源与 SHA-256 锁（manifest）把关，lint 不负责。
- 新增 vendored 目录时，必须同步在 `biome.json` 排除，否则门禁会被产物噪声打回；本条作为工具流程约束。
- 排除项只针对路径前缀，不影响源码目录；若某源码目录被误排除，lint 面会变小，需在评审中确认排除路径确实都是产物目录。

## 验证

- 追加排除后 `pnpm lint` 通过（`Checked 321 files`，0 error）；此前为 156 errors（全部来自 `weasel_upstream/*.js`、`resources/rime/**`、`resources/vad/ten_vad.js`、`.cache-vad/ten_vad.js`、`.cache-rime/*.json` 等 vendored 文件）。
- `git check-ignore` 确认被排除路径均为 `.gitignore` 忽略项，排除前后这些文件在 Git 中的状态不变（始终未跟踪）。
