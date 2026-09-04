# fix-sensenova-429-quota-retry 任务清单

## 1. 429 分类与退避指导（adapter.ts）

- [x] 1.1 新增 429 错误体解析与分类工具：解析 `error.code`，配额类 = `code === 8` 或 `code === 429001`，其余（含无 code）归非配额类；附单元测试（覆盖两种配额 code、无 code、`type` 为 `invalid_request_error` 的 429001 现场样本）
- [x] 1.2 配额类 429 映射 `RATE_LIMIT` 并携带 `providerRetryAfterMs` 下限：code 8 → 15000ms、429001 → 60000ms；响应携带更大 `Retry-After` 时采用 `Retry-After`；非配额类维持现行透传规则（≤单次延迟上限透传，超长不透传不截断）；附单元测试

## 2. 重试策略收敛（adapter.ts）

- [x] 2.1 `providerRetryPolicy` 从 `maxRetries: 1000`、上限 3000ms 收敛为 `maxRetries: 10`、退避单次上限 60000ms；删除/调整 `PROVIDER_RETRY_AFTER_CAP_MS` 相关常量与注释；附单元测试断言新策略值

## 3. 超时与看门狗（adapter.ts / concurrency.ts）

- [x] 3.1 生成请求叠加连接/首字节超时 45s（`AbortSignal.timeout` 与宿主 `signal` 组合），超时以可重试 `TIMEOUT` 错误结束并释放并发额度；附单元测试（模拟挂起 fetch，用假定时器断言 45s 触发）
- [x] 3.2 SSE 读取循环增加流空闲看门狗 60s（任一流式事件重置计时），停摆时以 `TIMEOUT` 结束并释放额度；附单元测试（模拟只发一个 chunk 后静默的流）
- [x] 3.3 `KeyedConcurrencyGate.acquire` 增加 `queueTimeoutMs`（默认 60000ms），排队超时以可重试错误 reject 且不占额度；更新既有并发闸测试并新增排队超时用例

## 4. 可选配额类粘性轮换（index.ts / adapter.ts / accounts.ts）

- [x] 4.1 `src/index.ts` 连接 schema 新增 `quotaRotation` 布尔设置（默认 `false`），随 `options()` 下发到 adapter；附 schema 默认值测试
- [x] 4.2 `stream()` 实现粘性轮换：开关开启且配额类 429 时切到下一把未试过的 key 重试并粘住（会话维度记住当前 key），环回后停留在当前 key 抛 `RATE_LIMIT`；关闭时行为与现状一致；429 不冷却、不禁用账号不变；附单元测试（开启/关闭/环回三场景）
- [x] 4.3 更新 `src/accounts.ts` 轮换辅助（如需）：区分「配额类轮换」与「401 禁用轮换」入口，配额类轮换不写任何账号状态

## 5. 设置页开关（client）

- [x] 5.1 `src/client/settings.ts` 高级设置折叠区新增「配额类 429 换 key」开关（默认关），文案：「仅限流耗尽时切换到下一把 key 并粘住；密钥失效（401）行为不变」；保存经 settings 命名空间持久化并热生效
- [x] 5.2 设置页既有「轮换说明文案」与新开关共存校验：默认轮换说明不因新开关存在而误导（关闭时仍表述 429 不切换）

## 6. 验证与收口

- [x] 6.1 全量验证：`npm run typecheck`（或等价 tsc）、`npm test`、`npm run build` 全部通过；lib/ 产物如入库则同步重建
- [ ] 6.2 复跑（UNVERIFIED：用户环境可选项） `node debug_quota_probe4.mjs` 冒烟（可选、消耗少量配额）：确认修复思路与实测桶形态一致（观察 429 后长退避行为需在 DSH 双会话冒烟中完成，环境依赖项未执行时在 tasks 中注明 UNVERIFIED）
- [ ] 6.3 DSH 双会话并发冒烟（UNVERIFIED：用户环境执行）：两个会话同 key 并发运行 10 分钟，无「连续 >10 次短退避零成功」区间，任一会话最终能出完整回复；配额类 429 时开启开关验证粘性切换生效
