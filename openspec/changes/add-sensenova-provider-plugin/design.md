## Context

本插件面向 DeepSeek Harness 宿主（本机基线 `0.1.2-alpha.3`，alpha 线），复用参考插件 `@mars-sea/dsh-commandcode-provider` 的结构，但只保留「多账号轮换」这一项能力，其余（用量 dashboard、登录流、web search、plan 感知等）全部不实现。动机见 proposal.md - Why。

宿主接口契约（已核对 `@deepseek-ai/dsh-llm@0.1.2-alpha.3`）：

- 适配器继承 `LlmAdapter`，必须实现 `stream()`，建议实现 `providerInfo()` / `listModels()` / `resolveModel()` / `providerRetryPolicy()`。
- 注册用 `ctx.llm.registerAdapter(['sensenova'], adapter)` + `ctx.llm.registerConfigurableProviders([{provider, displayName, settingsNs, settingsPath}])`。
- 设置段用 `ctx.inject(['settings'])` → `settings.installSection(ctx, NS, Config, config, {...})`。
- 每个出站 provider 请求必须带 `attributionHeaders()`（`user-agent`），不可省略。
- SenseNova 端点是 OpenAI 兼容协议：`GET /v1/models` 列目录、`POST /v1/chat/completions`（SSE）流式生成；无鉴权时 `/v1/models` 返回 401。

## Goals / Non-Goals

**Goals:**

- 注册独立 `sensenova` 路由，提供多账号配置（默认 key + `accounts[]` + `activeAccount` + 共享 `apiBase`）。
- 在流开始前完成多账号轮换：429 按 `Retry-After` 冷却、401 禁用，耗尽后给出明确错误。
- 从 `/v1/models` 实时拉取模型目录。
- 提供 Web 设置页（`settings.section` + `settings.models.provider-card`）。

**Non-Goals:**

- 不实现用量/账单/套餐展示，不做浏览器登录，不做 web search，不做 plan 感知选择器。
- 不做图片门控与推理强度快照。
- 不做 commandcode 特有的 5 小时窗口探测与近无界重试。

## Decisions

**D1：独立 `LlmAdapter`，不复用 `llm-pi-ai`。**
内置 `llm-pi-ai` 每个 provider 只支持单一 `apiKeyEnv`，无多账号轮换，无法满足需求。自写 adapter 可完全掌控轮换与流式翻译。

**D2：轮换状态以 API key 为键，存内存 Map。**
与参考插件一致：两个 slot 配同一 key 共享一条状态；key 在凭据服务中被改值 = 新键、状态自然清零。不持久化，重启后全账号恢复可用。

**D3：429 冷却时长来自 `Retry-After`，不再探测窗口。**
命令式标记：`markRejected(key, 'rate-limit', retryAfterMs)` 直接写 `cooldown { until }`；`Retry-After` 缺失时用 `DEFAULT_429_COOLDOWN_MS = 60_000` 兜底。删除参考插件的 `probeWindow` 与 `FiveHourWindowProbe` 整条链路。

**D4：401 永久禁用该 key。**
`markRejected(key, 'invalid-credential')` 写 `disabled { until: 0 }`，直到该 key 值在凭据服务中被修改（新 key = 新状态）。

**D5：轮换只在响应头返回前。**
`stream()` 里 `POST /v1/chat/completions` 成功拿到 `response.ok` 即锁定当前 key，SSE 流出字后的任何失败不再回放、直接结束。

**D6：重试用宿主默认。**
`providerRetryPolicy()` 返回 `undefined`（走宿主默认）；429/401 由轮换层处理，5xx/网络由宿主默认退避处理。

**D7：`peerDependencies` 不设上界。**
宿主接口包全部 `peerDependencies` 用 `>=0.1.2-alpha.3`（用户既有规则，区别于参考插件的 `^` 写法）。

**D8：Web 设置页走 `slots`。**
客户端 `ctx.slots.inject('settings.section', ...)` 注册整页，`ctx.slots.inject('settings.models.provider-card', ...)` 注册 Models 页卡片，key 均为 `llm-sensenova`。

**D9：流式翻译借鉴 `dsh-llm-pi-ai` 的 `toStreamChunks`。**
OpenAI SSE（`choices[].delta` / `finish_reason` / `usage`）→ `StreamChunk` 的转换逻辑参考内置 `dsh-llm-pi-ai` 的实现精简移植，不新增第三方流式库。

## Risks / Trade-offs

- [429 响应缺失或无法解析 `Retry-After`] → 用 60s 固定兜底冷却，避免对上游重试风暴；兜底值做成常量便于后续调整。
- [`/v1/models` 需鉴权，目录拉取依赖可用 key] → `listModels()` 先经账号池取第一个可用 key；无任何 key 时返回空目录（advisory），不阻塞路由注册。
- [轮换上限] → `tried.size < 账号数` 保证每个 key 至多尝试一次，避免共享同一 key 的多个 slot 造成死循环。
- [全账号 401] → 抛 `INVALID_CREDENTIAL`；全账号冷却 → 抛 `RATE_LIMIT` 并附最早恢复的 `providerRetryAfterMs`（`<= 900s` 才附）。
- [敏感凭据] → 实现只处理 key 的路径/长度/元数据，key 值走宿主凭据服务，不进日志、不发送给模型（隐私边界写入 spec）。

## Migration Plan

- 部署：`dsh plugin --profile web add @alaxrpg/dsh-sensenova-provider@alpha` 后重启 web。
- 回滚：`dsh plugin --profile web remove @alaxrpg/dsh-sensenova-provider`，或注释/删除 profile `cordis.patch.yml` 里的 `llm-sensenova` 行再重启。
- 与既有 `sensennova`（pi-ai）并存，互不影响；如需迁移，用户在 Models 页重新选择 `sensenova` 路由。

## Open Questions

<!-- 无可安全延后的未知项；§6/§7 的轮换语义与重试策略已在探索阶段与用户确认。 -->
