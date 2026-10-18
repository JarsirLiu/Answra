# Note：公告接口测试的陈旧调用下标断言

状态：已实施

## 问题

`apps/desktop/test/authService.test.ts` 中两个公告用例（列出可见公告、标记公告已读）在 `main` 上持续失败，阻塞 `pnpm verify`。失败表现为断言「首个 HTTP 调用是公告请求」，实际收到的是 `GET /api/v1/capabilities`。

## 涉及范围

- 代码/模块：`apps/desktop/test/authService.test.ts`
- UI/进程/协议/持久化表面：无（仅测试代码，不涉及运行时行为）
- 相关 Note：[桌面账号登录与凭据](../feature/2026-10-17-desktop-account-login-and-credentials.md)

## 决定

测试不再依赖 `harness.calls` 的固定下标，改为按 URL 定位目标调用后再断言其方法、鉴权头与请求体。

## 根因

`AuthService.restore()` 在登录态下会先请求 `GET /api/v1/capabilities` 刷新能力集（`authService.test.ts` 中另有专门用例覆盖该行为）。公告用例先保存凭据再调用 `restore()`，能力请求因此成为 `calls[0]`、公告请求顺延为 `calls[1]`；而两个断言仍读取 `calls[0]`，于是匹配到能力请求而非公告请求。

## 修复

把两处 `expect(harness.calls[0]).toMatchObject({ url: <公告地址>, ... })` 改为 `harness.calls.find((call) => call.url === <公告地址>)` 后再断言。列表用例保留 authorization 断言，标记已读用例保留 method / body / authorization 断言。

## 曾考虑的替代方案

- **把 `calls[0]` 改成 `calls[1]`：** 舍弃。硬编码下标在 `restore()` 前置请求数量再次变化时会立刻失效，且失败信息无法说明缺少的是哪次请求。
- **断言 `calls.at(-1)`：** 舍弃。语义模糊，无法表达「必须存在这次公告请求」，仍被动依赖调用顺序。

## 后果与防回退

- 公告相关断言一律按 URL 定位，不再依赖 HTTP 调用顺序；新增上游请求不会使其失效。
- 仅修复测试，未改动 `AuthService` 行为：若将来移除 `restore()` 的能力探测，现有 capabilities 专测会先行失败，回退信号明确。

## 验证

- `pnpm --filter @answra/desktop exec vitest run test/authService.test.ts`：26 项通过。
- `pnpm verify` 全绿。
