# 提案：放大 429 重试预算并修正 Retry-After 采用封顶断层

## Why

`fix-sensenova-429-quota-retry`（2026-09-08 归档）将 `maxRetries` 从 1000 收敛到 10，前提假设是「10 次 × 15–60s 退避已覆盖可预期的配额恢复窗口」。实测该假设不成立：多会话/agent 并发共享同一把 key 时会持续耗干 per-key TPM 桶，429001 恢复窗口可超过 10 次预算（约 2 分钟），单步请求显式失败并中断 agent 任务。另存在一个尚未暴露的断层：配额类 `providerRetryAfterMs` 封顶 300s 超过宿主策略 `maxDelayMs`（60s），一旦服务端返回 `Retry-After > 60s` 被采用，宿主 `dsh-llm-retry`（normal 模式）会直接放弃重试、立即显式失败——比撞次数上限更快。

## What Changes

- `providerRetryPolicy` 的 `maxRetries` 从 10 提高到 100（宿主按 `step/start`/`turn/end` 重置计数，为单个 agent 步骤内的预算）。100 次 × 15s 封顶档位约 25 分钟恢复窗口，比原 10 次（约 2 分钟）大幅放大；更长故障（日配额级）仍显式失败，「预算有限」的设计目标保留。
- 配额类 `Retry-After` 采用值封顶（`QUOTA_RETRY_AFTER_CEILING_MS`）从 300000 毫秒收紧为 60000 毫秒，对齐重试策略单次延迟上限 `maxDelayMs`（保持 60000 毫秒不变），消除「采用值超过 `maxDelayMs` → 宿主直接放弃重试」的断层。
- 分级冷却档位维持现状不调整：TPM 类（429001）保持 `3000 → 5000 → 10000 → 15000` 封顶，速率类（code 8）保持固定 15000 毫秒，连续命中计数语义不变（有意取舍：不引入 30s/60s 长档，保住「恢复第一时间接上」的短档探测灵敏度，代价是 15s 封顶后平坦轮询、预算以约 25 分钟为限）。
- 非配额类 429、TIMEOUT 等其他可重试错误的行为不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `sensenova-provider`: 「429 不冷却不轮换」Requirement 的 `Retry-After` 采用值封顶 300000 → 60000 毫秒；「Provider 重试策略」Requirement 的最大重试次数上限 10 → 100。分级档位与计数语义均不变。

## Impact

- 代码：`src/adapter.ts`（`QUOTA_RETRY_AFTER_CEILING_MS` 常量、`providerRetryPolicy` 的 `maxRetries`）；`tests/adapter.test.ts` 同步断言。
- 行为：宿主重试层预算窗口从约 2 分钟放大到约 25 分钟；`providerRetryAfterMs` 上限变化对宿主 `dsh-llm-retry` 的兼容性从「存在放弃重试断层」修复为「采用值恒 ≤ maxDelayMs」。
- 不涉及设置项、UI、账号轮换逻辑（`quotaRotation` 行为不变，换 key 依然是长故障下最快的解法）。
