# Tasks: align-request-fields-with-docs

实现者视角，逐条可验证。验收命令统一为：`npx tsc --noEmit`（typecheck）、`npm test`（或项目现有 test 脚本）、`npm run build`。

## 1. 档位矩阵与 defaultEffort

- [x] 1.1 修正 `src/adapter.ts` `KNOWN_EFFORTS` 静态表：6.8-flash-lite 补 `max`；deepseek-v4-flash 补 `max`；新增 `deepseek-flash`（原生 none/low/high/max + 兼容映射 minimal→low、medium/xhigh→high、ultra→max）；glm-5.2 改七档默认 `max`；kimi-k3 补 `medium` 默认 `max`；删除 `deepseek-v4-pro` 条目
- [x] 1.2 `reasoningInfoFrom()` 命中静态表时随 `reasoning.efforts` 声明 `reasoning.defaultEffort`（目录词表存在时仍以目录为准）
- [x] 1.3 单测覆盖：每个模型返回的 efforts 集合与 defaultEffort 精确匹配本表；`deepseek-v4-pro` 不再有静态条目
- 验收：`npm test` 中档位矩阵用例全绿

## 2. Chat 请求体字段分派

- [x] 2.1 `buildOpenAiBody()`：kimi-k3 输出上限改发 `max_completion_tokens`（其余模型维持 `max_tokens`）；单测断言两种出站字段名
- [x] 2.2 `buildOpenAiBody()`：流式请求对 6.8/v4-flash/v4.1-flash/kimi-k3 显式发送 `stream_options:{include_usage:true}`，glm-5.2 不发该字段；单测断言
- [x] 2.3 `toOpenAiMessages()`：按模型分派 `reasoning_content` 回放——deepseek-v4-flash/deepseek-flash 且带 `tools` 时回放全部历史思维链；其余模型或不带 `tools` 时不携带；单测覆盖 4 组合（deepseek±tools、非 deepseek±tools）
- [x] 2.4 字段裁剪：glm-5.2 不发 `thinking`（`none` 经 `reasoning_effort:"none"` 表达）；kimi-k3 不发 `frequency_penalty`/`presence_penalty`/`temperature`/`top_p`；目录 `supported_sampling_parameters` 未列出的采样字段（如 `seed`/`n`/`parallel_tool_calls`）不发；单测断言出站请求体字段集合
- [x] 2.5 `reasoning_effort` 出站策略：值域内原样；deepseek-flash 兼容映射改写；值域外（含 kimi-k3 `none`→`thinking:"disabled"` 特例）不发送未知值；单测覆盖映射表与特例
- 验收：`npx tsc --noEmit` + `npm test` 全绿

## 3. 主 spec 拆分与归档准备

- [x] 3.1 确认 delta spec 中「流式生成」「模型能力自动配置」MODIFIED 块已精简（≤500 字符/条）且未丢场景；归档后 `openspec validate sensenova-provider --type spec` 不再对这两条报超长 warning

## 4. 文档与清理

- [x] 4.1 修正 `README.md` 中 429 重试相关描述与实际行为不一致处（对照主 spec「429 不冷却不轮换」「Provider 重试策略」）
- [x] 4.2 删除根目录 `debug_*.mjs` 临时调试脚本（先 `ls debug_*.mjs` 列出实际文件再删，确认无生产引用）

## 5. 收口验证

- [x] 5.1 `openspec validate align-request-fields-with-docs --strict` 通过
- [x] 5.2 `npx tsc --noEmit`、`npm test`、`npm run build` 三命令通过；git diff 复核无越界写入（仅 `src/adapter.ts`、测试、README、删除 debug 脚本）

## 实现证据（wire-builder，实际命令用 pnpm 等价执行）

- 1.1/1.2：`src/adapter.ts` `KNOWN_EFFORTS: ReadonlyMap<string, StaticEffortFacts>`（六模型族，deepseek-v4-pro 已删，含 compat 映射）；`reasoningInfoFrom()` 目录默认档优先、静态 `defaultEffort` 兜底。
- 1.3：`tests/adapter.test.ts` 「静态档位矩阵精确匹配文档表（align 1.1/1.3）」六模型 efforts/defaultEffort 全精确断言 + deepseek-v4-pro reasoning undefined。
- 2.1–2.5：`src/adapter.ts` `ChatFieldPlan` + `chatFieldPlan(model, entry)`（maxTokensField/streamOptionsUsage/replayReasoningWithTools/blockedSampling/effortCompat/noneMapsToThinkingDisabled），`buildOpenAiBody(options, entry)` 与 `toOpenAiMessages(options, replayReasoning)` 消费；kimi `none`→`thinking:"disabled"` 处注释标注「待实测修正」。`supported_sampling_parameters` 解析于 `parseCatalog`（`CatalogEntry.supportedSamplingParameters`），静态兜底 `KNOWN_SAMPLING_PARAMS`（仅 6.8 含 seed/n/parallel_tool_calls；GenerateOptions 无 seed/n 字段故只能白名单放行，无出站路径）。
- 2.x 单测：`tests/adapter.test.ts` 尾部「align-request-fields-with-docs 新增用例」段 6 个用例（captureBody 助手捕获出站 body）。
- 3.1：delta spec（`openspec/changes/align-request-fields-with-docs/specs/sensenova-provider/spec.md` 137 行）「模型能力自动配置」「流式生成」MODIFIED 块均 ≤500 字符且场景齐全（逐条通读核对）。
- 4.1：`README.md` / `README.zh-CN.md` 12–16 行 429 描述改为「不冷却不轮换、抛 RATE_LIMIT 交宿主重试层（Retry-After 封顶 60s）、quotaRotation 配额类粘性换 key；401 轮换+禁用」，删「最早恢复时间」过时句。
- 4.2：`ls debug_*.mjs` 列出 7 个（cache_probe/quota_probe×4/repro/smoke_dualsession）后删除；grep 确认 src/tests/docs/README/package.json 无引用。
- 5.1：`npx --yes openspec validate align-request-fields-with-docs --strict` → `Change 'align-request-fields-with-docs' is valid`。
- 5.2：`pnpm exec tsc --noEmit`（无输出）、`pnpm test`（103/103 pass，0.6s）、`pnpm run build`（ESM+CJS 全部产物 emit 成功）。git status 变更仅 src/adapter.ts、src/index.ts、tests/adapter.test.ts、README.md、README.zh-CN.md、lib/* 构建产物、删除 7 个 debug_*.mjs、勾选本 tasks.md；package.json/openspec 其余变更为 task-13 与 Lead 归档操作。
