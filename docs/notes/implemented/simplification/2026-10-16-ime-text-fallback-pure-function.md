# Note：IME 引擎拒绝文本回落决策下沉为纯函数（S4）

状态：已实施

## 问题

内置输入法在 `engineHandled === false`（引擎拒收某个键）时，需要决定"这个键的文本直接写进编辑器"还是"交回编辑器路由"。该决策以两个内联布尔量写在 `useEmbeddedIme.sendKey` 的结果回调里：

- `printableFallback`：ASCII 模式下任意可打印文本。
- `chineseNumericFallback`：中文模式、未处于 composing、单个未按 Shift 的数字键。

它读的是 hook 局部变量 `keyEvent`（`key`/`text`/`shift`/`ctrl`/`alt`/`meta`）与结果里的 `result.snapshot.engine`。后果：这条**纯判定**只能靠渲染整个 hook 的集成测试覆盖；新增回落规则时要在 hook 里再插一个布尔量，hook 继续承担"文本路由策略"这一非副作用职责。这正是提案 S4 指出的"第二判断路径"之一。

## 涉及范围

- 代码/模块：`packages/ui/src/ime/imeTextPolicy.ts`（新增纯函数）、`packages/ui/src/hooks/useEmbeddedIme.ts`（改为调用该函数）、`packages/ui/test/imeTextPolicy.test.ts`（新增用例）。
- 行为：无变化——两条回落规则与判定条件逐字保留（Shift 不阻止 ASCII 回落、但阻止中文数字回落；任一 Ctrl/Alt/Meta 一律不回落）。
- 相关 Note：[可判定性与单一写入者提案](../../proposed/architecture/2026-10-15-ime-authoritative-session-and-input-routing.md)。

## 决定

在 `imeTextPolicy.ts` 增加纯函数 `resolveImeTextFallback(input: ImeTextFallbackInput): string | undefined`，由调用方提供结果里的 `engine` 与键事件字段，返回应提交的文本（或 `undefined` 表示不回落）。`useEmbeddedIme` 的结果回调改成构造入参、调用它、返回文本即提交：

1. 判定顺序：无 `text` → 不回落；任一修饰键 → 不回落；`ascii` → 提交文本（保留 Shift）；`chinese` 且未 composing 且未 Shift 的单个数字 → 提交文本；其余 → 不回落。
2. 原有回调内的 `result.engineHandled !== false` 重判删除：调用点只在 `engineHandled === false` 时触发该回调，属冗余检查。

## 移除内容

- `useEmbeddedIme.sendKey` 结果回调内的 `chineseNumericFallback`、`printableFallback` 两个内联布尔量及其正则/修饰键判断。
- 该回调内重复的 `result.engineHandled !== false` 早退（由调用点 `enqueueInput` 保证）。

## 重新引入条件

- 新增或修改文本回落规则，只允许改 `resolveImeTextFallback`；禁止在 `useEmbeddedIme` 或任何组件内再内联回落布尔量。
- `ImeTextFallbackInput` 只能由命令结果与键事件字段填充，不得从 session/focus 状态或 DOM 读取。

## 曾考虑的替代方案

- **留在 hook 内联，仅补 hook 级测试：** 舍弃。判定是纯的，不需要 DOM、session 或 timer 才能验证；下沉后可用普通单测覆盖边界（Shift、修饰键、composing）。
- **放进 `imeKeyRouter`：** 舍弃。`resolveImeKeyRoute` 在"引擎作答之前"把键+状态映射成路由；本决策发生在"引擎作答之后"（`engineHandled === false`），router 永远看不到结果对象，塞进去会引入它不该知道的命令结果类型。
- **抽成新的独立模块 `imeTextFallback.ts`：** 舍弃。功能属"文本事件如何路由"这一既有边界（`imeTextPolicy.ts` 的注释已声明它只决定原生文本去向、不拥有 session/focus/editor 状态），单开文件只会增加入口而不增内聚。

## 后果与防回退

- hook 只负责"把结果分派给回调"，不再持有文本回落策略；回落规则集中在一处、可单测。
- 有意保留 `ImeTextPolicy` 与 `resolveImeTextFallback` 同文件：前者决定"原生文本是否被拦截"，后者决定"引擎拒收后是否由编辑器直接写入"，二者共同构成文本事件路由，边界一致。

## 验证

- `packages/ui/test/imeTextPolicy.test.ts` 9 项通过（新增 7 项：ASCII 含 Shift 提交、中文未 composing 数字提交、composing 数字不提交、中文非数字不提交、含修饰键不提交、中文 Shift+数字不提交、无文本不提交）。
- `packages/ui/test/useEmbeddedIme.test.tsx` 22 项通过（行为等价由原断言保证）。
- `pnpm verify` 全绿。
