# Note：CI Node 版本下限随 pnpm 11.9 提到 22.13

状态：已实施

## 问题

仓库两处版本钉子互相矛盾：`packageManager` 钉了 `pnpm@11.9.0`，其 engines 要求 Node.js ≥ 22.13；而 `.nvmrc` 钉的是 `22.12.0`，CI（`pnpm/action-setup` 先按 packageManager 装 pnpm，`setup-node` 再按 `.nvmrc` 装 Node）装出 pnpm 11.9 + Node 22.12 的组合，`pnpm install` 直接报
`ERROR: This version of pnpm requires at least Node.js v22.13 … The current version of Node.js is v22.12.0`，CI 在 Install dependencies 步骤即失败。本地开发（Node 24）不受影响，所以问题只在 CI 暴露。`package.json` 的 `engines.node: ">=22.12.0"` 与 README「Node.js 22.12 或更新版本」同样声明了一个实际跑不通的下限，属于同一处失真。

## 涉及范围

- `.nvmrc`：`22.12.0` → `22.23.4`（22.x LTS 当前最新安全补丁，2026-10-21 发布）。
- `package.json`：`engines.node` → `">=22.13.0"`。
- `README.md` 环境要求一行同步为 22.13。
- 不涉及任何源码与运行时行为；只影响 CI 安装的 Node 版本与文档化的最低环境要求。

## 流程变化

- CI 的 Node 运行时由 22.12.0 升到 22.23.4（`setup-node` 读 `.nvmrc`），`pnpm install` 起的全部 CI 步骤在新运行时上执行。
- 文档化的最低开发环境从「Node.js 22.12+」收紧为「Node.js 22.13+」，`engines.node` 与之一致。

## 决定

以 pnpm 11.9 的真实下限（22.13）为事实来源统一三处版本声明：`engines.node` 与 README 写 22.13（下限就写真实下限，不虚高），`.nvmrc` 直接钉到 22.x LTS 的最新补丁 22.23.4 而不是刚好 22.13.0——维护期 LTS 的旧补丁积攒了十几轮安全修复，CI 没有理由故意装旧的。Node 22 线 2027-04 EOL，届时应整体评估切到更高 LTS（本地开发已在 Node 24）。

## 曾考虑的替代方案

- **`.nvmrc` 只提到 22.13.0（刚好过线）**：能修 CI，但把 CI 钉在一个 2025 年初的补丁上，错过其后所有安全修复；选最新 22.x 补丁没有额外成本，舍弃。
- **把 pnpm 降到支持 Node 22.12 的 10.x**：让旧 Node 活下去，但 `packageManager` 钉 11.9 是既有决定，降级 pnpm 是反向修复，还会丢 11.x 的行为改进，舍弃。
- **CI 改装 Node 24 LTS（本地开发同款）**：CI 与开发者本机完全对齐有吸引力，但这是运行时大版本跳变，超出「修 CI 钉子打架」的最小变更面；22.x 仍在维护期内，留作 2027-04 EOL 前的独立决策，舍弃。

## 后果与防回退

- 三处版本声明（`.nvmrc`、`engines.node`、README）必须继续一致地表达同一事实：**升级 `packageManager` 里的 pnpm 时，必须同步核对它的 Node 下限并一起改 `.nvmrc`/`engines`/README**——这次的失败模式就是只动了其中一处。反向操作（降 pnpm）同理。
- `.nvmrc` 钉的是具体补丁版本，后续安全更新不会自动跟进；定期（或随安全公告）把 `.nvmrc` 提到 22.x 最新补丁即可，`engines` 下限不用跟着动。
- CI 环境从 22.12 升到 22.23.4 属于同一大版本内的补丁跳变，V8/ABI 无破坏，Electron 与 node-gyp 依赖不受影响；若 CI 在新 Node 上出现行为差异，应查依赖本身而不是回退本改动。

## 验证

- 推送 `4809b41` 后 CI 在 Install dependencies 步骤失败，错误信息明确指向 pnpm 11.9 要求 Node ≥ 22.13、当前 22.12.0，与 `.nvmrc` 内容吻合（复现路径确认，非猜测）。
- 本修改后再推送，CI 应能通过 Install dependencies 并走完后续步骤；`pnpm verify` 本地全绿确认改动未破坏任何门禁。
