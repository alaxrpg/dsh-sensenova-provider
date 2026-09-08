# 任务清单：放大 429 重试预算并修正 Retry-After 采用封顶断层

## 1. 适配器实现

- [x] 1.1 `src/adapter.ts`：`QUOTA_RETRY_AFTER_CEILING_MS` 从 `300_000` 改为 `60_000`，同步更新注释（对齐 `PROVIDER_RETRY_AFTER_CAP_MS`/宿主 `maxDelayMs`，注明宿主 normal 模式在 `providerRetryAfterMs > maxDelayMs` 时会直接放弃重试、封顶收紧以消除该断层）
- [x] 1.2 `src/adapter.ts`：`providerRetryPolicy` 的 `maxRetries` 从 `10` 改为 `100`，同步更新 D3 注释（预算窗口约 25 分钟、单 agent 步骤内预算）

## 2. 测试同步

- [x] 2.1 `tests/adapter.test.ts`：`providerRetryPolicy` 用例（maxRetries=10 断言）同步为 `maxRetries=100`
- [x] 2.2 `tests/adapter.test.ts`：「429001 成功后探测档位归零，Retry-After 更大时优先」用例中 `retry-after: 90` 的断言从 `90_000` 改为 `60_000`（配额类采用值封顶 60000 毫秒，覆盖 spec 新 scenario「配额类 Retry-After 采用值不突破单次延迟上限」）

## 3. 验证与构建

- [x] 3.1 运行 `npm test` 全量通过（86/86 pass）
- [x] 3.2 运行 `npm run typecheck` 与 `npm run build`，同步 `lib/` 编译产物（产物含 `maxRetries: 100` 与 60000 封顶值）
