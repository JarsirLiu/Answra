# Note：禁止商用的开源许可（PolyForm Noncommercial 1.0.0）

状态：已实施

## 问题

项目明确要求"禁止商用"，但仓库没有任何 LICENSE 文件。缺省的"无许可"状态在版权法下意味着他人连使用许可都没有，而一旦未来公开仓库，最先被社区指出的问题就是许可真空。常见宽松许可（MIT/Apache-2.0）都允许商用，无法满足要求；Creative Commons NC 系列是为内容创作设计的，明确不适合软件（无专利条款、与依赖生态冲突、歧义官司风险）。

## 涉及范围

- 代码/模块：根目录 `LICENSE` 新增；根 `package.json` 增加 `"license": "PolyForm-Noncommercial-1.0.0"`；`README.md` 新增"许可"章节并在"参与开发"加贡献授权条款；`CONTRIBUTING.md` PR 要求加提交即授权声明。
- 流程表面：变更仓库对外授权姿态，不改变任何代码、构建或 CI 行为。
- 相关 Note：[提交前 AI 自检 skill](../../archived/process/2026-10-20-ai-submit-self-check-skill.md)（其中的"秘密与工件/依赖许可"检查项与此呼应，现收编于 answra-code 终篇）。

## 流程变化

- 仓库对外授权姿态从"无许可"变为"源码可用 + 禁止商用"：个人/非商业组织免费，商用需联系授权。
- 今后所有称"开源/许可"的表述统一指向 PolyForm Noncommercial 1.0.0；对外文案（README、发布页）不复用"Copyright (c) Yoyodyne"示例行的占位写法，按 LICENSE 的 Required Notice 行为准。
- 引入新依赖时许可检查归属提交前自检清单（`.agents/skills/answra-code/SKILL.md` 终篇），无需新工具。

## 决定

采用 **PolyForm Noncommercial License 1.0.0**（SPDX: `PolyForm-Noncommercial-1.0.0`）：

- 任何非商业用途（个人学习/研究/非商业组织/政府机构）免费使用、修改、分发，含专利许可与 32 天违规补救条款；
- 任何商业用途必须另行联系获得授权（README 声明通过 GitHub Issues 联系）；
- 采用 SPDX 官方文本，`Required Notice` 行声明版权归属 `JarsirLiu`（如对外主体有变，只改该行与 README 提及处）。

PolyForm 系列由资深开源法律顾问起草，是"源码可用但禁止商用"的教科书级选择，比自写许可或 CC-NC 更少歧义。

## 曾考虑的替代方案

- **MIT / Apache-2.0：** 最标准的开源许可，但明确允许商用，与产品硬性要求冲突；舍弃。
- **Creative Commons BY-NC 4.0：** 知名度最高，但 CC 官方明确不推荐用于软件：无专利条款、与大多数依赖许可体系不兼容、术语（如改用/分发）不适配代码；舍弃。
- **自写许可：** 表达力完全可控，但无法律检验、维护成本高、GitHub 无法识别；舍弃。
- **AGPL-3.0 或 Elastic/BSL 等源码可用数许可：** 它们限制的是竞争行为（如托管服务）而非商用本身，公司内部使用仍可商业化；与"禁止商用"要求不符；舍弃。

## 后果与防回退

- 本项目在 OSI 定义下是 **source-available** 而非"开源"（Open Source）；README 已如实采用"源码可用+禁止商用"的表述，不使用"开源"自我标榜。
- 防回退：不得将根/LICENSE 或 `package.json` 的 license 字段改回 MIT/Apache 类可商用许可；若未来产品策略确需调整授权姿态，必须走新 Note 重新决策，不允许顺手改。
- 引入新 third-party 依赖时检查其许可与本项目 NC 姿态的兼容性（已并入 `.agents/skills/answra-code/SKILL.md` 终篇的收编检查）。
- 公开仓库前需确认 `Required Notice` 行的版权主体是否需要改为正式实体。

## 验证

- `LICENSE` 内容与 SPDX license-list-data 的 `PolyForm-Noncommercial-1.0.0` 规范文本一致（来源 polyformproject.org 官方站点）。
- `pnpm notes:hint` 对本变更的 Note 配对提示消除；CI 的 license 未检出问题（Vitest/构建不依赖 license 字段）。
