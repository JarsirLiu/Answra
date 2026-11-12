# Note：Release 工作流 job 级 if 引用 matrix 导致 workflow 无效

状态：已实施

## 问题

`.github/workflows/release.yml` 在 `build` 作业上用 job 级 `if` 过滤手动触发的平台：

```yaml
strategy:
  matrix:
    include:
      - platform: windows
      - platform: macos
...
if: ${{ github.event_name != 'workflow_dispatch' || inputs.platform == 'all' || inputs.platform == matrix.platform }}
```

GitHub Actions 在加载 workflow 时报 `Invalid workflow file: (Line: 51, Col: 9): Unrecognized named-value: 'matrix'`，整个 `Release` 工作流无法启动。本次改动之前该文件从未在 GitHub 上被解析过（只在本地人工阅读），所以问题一直潜伏到第一次真正触发。

## 涉及范围

- 代码/模块：`.github/workflows/release.yml`。
- UI/进程/协议/持久化表面：无运行时行为变化；只影响发布流水线的平台筛选。
- 相关 Note：[GitHub Actions 双平台发布流水线](../process/2026-11-01-github-release-pipeline.md)、[Answer 版 macOS 自动构建与 Electron 下载重试](../process/2026-11-08-answer-macos-build-retry.md)。

## 根因

job 级 `if` 在 `strategy.matrix` 展开之前求值，可用上下文只有 `github`、`needs`、`vars`、`inputs`（`matrix`、`steps`、`job` 都不可用），所以任何在 `jobs.<id>.if` 里引用 `matrix.*` 的写法都会让 workflow 校验失败，而不是运行时跳过某个矩阵项。平台筛选必须发生在矩阵生成之前，不能发生在矩阵项展开之后。

## 决定

- 平台筛选前移到矩阵生成之前：新增 `prepare` 作业，在 job 级上下文（`github`、`inputs`）里算出矩阵，`build` 只消费 `fromJSON(needs.prepare.outputs.matrix)`，不再写 job 级 `if`。
- 筛选语义保持不变：tag 推送输出全平台；`workflow_dispatch` 输出 `all` 或所选单个平台；未知平台名直接失败（避免空矩阵静默成功）。
- `publish` 的 `needs: build` 与 `inputs.upload` / `inputs.platform == 'all'` 判断不变，仍只在 tag 或“双平台 + 勾选上传”时执行。

## 修复

- `prepare`（`ubuntu-latest`，5 分钟超时）：用 node 表达式读取 `github.event_name` 与 `inputs.platform`，从硬编码的平台表筛选，把 `{"include": [...]}` JSON 写入 `steps.resolve.outputs.matrix`；空结果 `::error::` 并退出 1。
- `build` 改为 `needs: prepare` + `matrix: ${{ fromJSON(needs.prepare.outputs.matrix) }}`，删除原 `if: ${{ ... matrix.platform }}` 一行，`runs-on: ${{ matrix.os }}` 与 `strategy.fail-fast: false` 保留。

## 曾考虑的替代方案

- **拆成 `build-windows` / `build-macos` 两个作业，各自写 `inputs.platform == 'windows' | 'macos'`：** 舍弃。两个作业要复制约 40 行安装/构建/上传步骤，平台差异一旦需要改动就要改两处，回到多套流水线的老问题。
- **保留静态矩阵，在 job 内第一步判断平台后 early-exit：** 舍弃。作业会显示为“成功”而实际什么都没构建，`publish` 的产物校验也随之失真，属于用运行时行为掩盖配置错误。
- **只保留 `github.event_name != 'workflow_dispatch'`（手动触发一律双平台）：** 舍弃。`workflow_dispatch` 的 `platform` 输入就是为单平台验证设计的，去掉会让手动验证固定消耗两个平台的 runner 分钟。
- **把矩阵 JSON 写进仓库内的静态 JSON 文件：** 舍弃。平台清单只有两行，多一个文件反而增加“改工作流却改错文件”的机会；筛选逻辑仍需表达式，无法省掉。

## 验收标准

- 可观察结果：GitHub 能正常解析 `Release` 工作流（不再报 `Invalid workflow file`）；`workflow_dispatch` 选 `macos` 时只出现 `Build macos`，选 `all` 时出现两个构建作业 + `Publish to COS and GitHub Release`。
- 自动化验证：`actionlint` 对 `.github/workflows/` 全部文件返回 0。
- 需要的实机验证：GitHub 上真实触发一次 `Release`（本地无法替代）。

## 风险

- `prepare` 每次运行都会额外占用一个 `ubuntu-latest` 作业（实际几十秒）；tag 发布时它也会执行一次。
- 平台表从 YAML 矩阵搬到脚本内的一个数组，两者不再是同一处声明；新增平台时若只改 `runs-on`/脚本字段而漏改数组，会得到“该平台不构建”的空筛选（未知名字会失败，漏加则不会）。

## 验证

- 负向对照：把原始 `if: ${{ ... || inputs.platform == matrix.platform }}` 片段放进临时 workflow，`actionlint 1.7.7` 报 `context "matrix" is not allowed here. available contexts are "github", "inputs", "needs", "vars"`，与 GitHub 的错误一致，证明该工具能覆盖本缺陷。
- `actionlint 1.7.7` 对 `.github/workflows/*.yml`（含修复后的 `release.yml`）返回 0。
- YAML 结构用 `yaml@2` 严格解析通过，`jobs` 展开为 `prepare`、`build`、`publish`。
- 未执行：GitHub Actions 上的真实运行。

## 后果与防回退

- 禁止在 `jobs.<id>.if`、`jobs.<id>.runs-on`、`jobs.<id>.strategy` 之外的 job 级字段引用 `matrix.*`；平台筛选只能通过 `prepare` 输出的矩阵完成。
- 新增平台时必须在 `prepare` 的平台表里加一项（`platform` / `os` / `script`），否则该平台永远不会被构建。
- 修改 workflow 后先跑 `actionlint` 再推送，避免再次出现“推上去才发现 workflow 无效”的返工。
