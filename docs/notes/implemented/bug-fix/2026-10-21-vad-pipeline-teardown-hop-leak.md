# Note：VAD pipeline 先清空后挂回调，hop 原生资源从不释放

状态：已实施

## 问题

为 `apps/agent/src/interview/vad/pipeline.ts` 补会话失败/释放行为测试（[面试语音 VAD 选型](../../proposed/architecture/2026-10-20-interview-vad-silero-runtime.md) 阶段 3 收口遗留项）时发现：`teardown` 先 `void engine.then(...)` 挂出异步释放回调，紧接着同步 `runtime.sources.delete(...)`；而回调里才遍历 `runtime.sources.values()`。引擎 load promise 在 teardown 前通常已 resolve（甚至常驻 pending），回调执行时 map 必为空——**`destroyHop` 从未被调到**。后果：每次 stop/fail/dispose，每通道一个 hop 的原生资源（`_ten_vad_create` 创建的句柄、四块 malloc、引擎内部状态引用）泄漏，长时间使用 utility process 的会话反复开关会持续累积。

## 涉及范围

- 代码/模块：`apps/agent/src/interview/vad/pipeline.ts`（`teardown` 一处）、`apps/agent/test/interview/vad/pipeline.test.ts`（推理失败/逐源路由两用例的 `destroyHop` 恰好一次释放断言）。
- UI/进程/协议/持久化表面：无接口变更。

## 根因

释放路径的执行顺序倒置：先注册耗时回调、后清空回调依赖的状态。属于典型的"异步回调引用同步清理后的引用"次序缺陷；没有把释放行为固化为断言（调用恰好一次）之前，这条死路径不会被任何既有测试发现。

## 决定

- `teardown` 把 `sources` 的引用先落袋（`[...runtime.sources.values()]`）再清 map，回调遍历落袋清单；异步语义保留。
- 释放所用的 promise 明确为 `this.engine`（共享 load promise；两处入口的 hop 都由该单例引擎 `createHop` 产出）。曾改为 `runtime.engine`（每会话已 resolve 的实例）直接 `.then`而误把对象当 promise，测试 `TypeError: engine.then is not a function` 证明其不可等价——恢复共享 promise，语义上"同一实例负责创建与销毁"。

## 修复

- `apps/agent/src/interview/vad/pipeline.ts`：`teardown` 重写为"落袋 → 清 map → 按 `this.engine` 回调释放"，另加 `sources.length === 0` 早退，避免暖机失败会话（无任何 hop）也排空一个 microtask。
- `apps/agent/test/interview/vad/pipeline.test.ts`：
  - `fails the session explicitly and releases the hop when inference throws`——推理抛错升级 `runtime-failed` 后 `vi.waitFor` hop 被恰好销毁一次；修复前此断言红的。
  - `routes frames per source so each channel keeps its own utterance timeline`——`dispose` 后双通道 hop 全部销毁。

## 影响表面

- 会话停止/失败/销毁后 hop 资源真正回到引擎；无协议或行为面变化。
- 暖机期（引擎未 resolve）会话失败时无源、无 hop、无可释放——与修复附带早退一致。

## 曾考虑的替代方案

- **改为同步 destroy（在 teardown 里同步 for 循环 destroyHop）：** stop/fail 是同步 API，无法先 `await` 引擎 resolve；暖机期 stop 的会话并没有 `runtime.engine` 可得，同步释放路径无法统一。异步释放保留原契约。舍弃。
- **用 `runtime.engine`（已 resolve 实例）+ 手工 Promise 包装：** 等价于直呼 `loaded.destroyHop`，但把"使用共享 promise"这一实现细节复制进 per-session 逻辑；未来若改为 per-session 引擎加载反而两边要迁。共享 promise 语义单一。舍弃。

## 后果与防回退

- 两用例以 `vi.waitFor(destroyed).toHaveLength(n)` 锁死释放语义；任何改回"先清 map"或漏注册回调的实现会红。
- `teardown` 早退条件显式写出（`!engine || sources.length === 0`），后续读者不必再推演不被调用的含义。

## 验证

- 修复前：`vi.waitFor` 超时，`destroyed` 恒为 `[]`（vitest diff 证据）；修复后 `pnpm --filter @answra/agent test -- pipeline` 6/6 通过。
- 真实 WASM hop 的 `_ten_vad_destroy`/`_free` 链路归 10-20 Note 阶段 7–8 实机验证。

## 附注

`destroyHop` 释放断言属于行为断言（恰好一次、全量销毁），不依赖假绑定内部结构（fake 引擎仅记录调用）。与 `tenVadEngine.test.ts` 里的假绑定观察点是两层验证。
