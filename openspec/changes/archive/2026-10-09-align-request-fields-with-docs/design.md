# Design: align-request-fields-with-docs

## Context

本变更是 `docs/sensenova-upgrade-plan.md` 版本切分中的 `0.2.0-alpha.1`（字段对齐）：纯 bug 修正，不引入 `src/wire/` 新抽象（那是 `make-responses-default-wire-protocol` 的范围），全部改动落在现有 `src/adapter.ts` 的静态表与请求构造函数内。

字段语义的唯一依据是官方文档原文 `/tmp/sn_docs_zh.md`（已二次抽查关键行）：

| 模型 | reasoning_effort 原文 | 默认 | 上限字段 |
|---|---|---|---|
| 6.8-flash-lite | :476 `low/medium/high/max` + `none` | high | `max_tokens`（:65536） |
| deepseek-v4-flash | :1297 `low/medium/high/max` + `none` | high | `max_tokens` |
| deepseek-flash | :1673 原生 `none/low/high/max`；兼容 `minimal`→low、`medium`/`xhigh`→high、`ultra`→max | high | `max_tokens` |
| glm-5.2 | :2022 `max/xhigh/high/medium/low/minimal/none` | **max** | `max_tokens` |
| kimi-k3 | :2403 `low/medium/high/max` | **max** | **`max_completion_tokens`**（:2446） |

思维链回传（:1411-1412、:1790-1791、:2539）：deepseek 系带 `tools` 必须回传全部历史 `reasoning_content`；不带 `tools` 忽略；6.8/glm/kimi 多轮不回传（kimi 仅要求原样回传完整 assistant message，即 content+tool_calls，不含思维链）。`stream_options.include_usage`：6.8(:551)/v4-flash(:1327)/v4.1-flash(:1703)/kimi(:2443) 默认 true，glm-5.2 参数表无此字段。glm-5.2 `thinking` 不支持 `disabled`（:2143，传入即失败）。

## Goals / Non-Goals

- Goals：修正档位表与 defaultEffort；kimi-k3 字段名；显式 stream_options；思维链回放分派；按模型/目录裁剪不支持字段。
- Non-Goals：Responses 协议、多模态输入（后续变更）；不做 `ModelFacts` 抽象（`add-model-facts` 范围），仅以现有 `KNOWN_EFFORTS` + 目录缓存的形态落地；不改 wire 协议与错误处理。

## Decisions

1. **静态表扩列而非新抽象**：`KNOWN_EFFORTS`（`src/adapter.ts:78-84`）改为「模型 → { efforts, defaultEffort, 兼容映射 }」结构，删除 `deepseek-v4-pro`。理由：本变更不依赖 `facts.ts`，最小改动面；`add-model-facts` 后续可整体迁移该表。
2. **目录词表优先级不变**：目录提供 `reasoning_efforts`/`reasoning_levels` 时完全采用目录值（含其默认档）；静态表仅在目录无词表且模型 id 命中时生效，并补 `defaultEffort`（修 P1-1）。
3. **思维链回放按「带 tools」判定**：`toOpenAiMessages()`（`src/adapter.ts:309-366`）新增参数（模型 id + 是否携带 tools），deepseek 系且带 tools 时把宿主历史 reasoning 增量重建为 assistant 项的 `reasoning_content`；其余分支维持只发 `content`+`tool_calls`。宿主历史中 reasoning 块的原文保留在消息里，无需额外存储。
4. **字段裁剪双通道**：静态「模型 → 禁发字段」表（glm-5.2: thinking、stream_options；kimi-k3: frequency/presence_penalty、temperature、top_p）+ 目录 `supported_sampling_parameters` 白名单（用于 `n`/`seed`/`parallel_tool_calls` 等目录显式列出的才发）。静态表处理文档明确的硬失败，目录白名单处理其余。
5. **`reasoning_effort` 出站策略**：值在模型值域内 → 原样；命中 deepseek-flash 兼容映射 → 改写后发送；均不在 → 不发送（用模型默认），不发未知值。
6. **顺带拆分超长 requirement**：主 spec「流式生成」「模型能力自动配置」文本已按任务要求精简拆分（档位矩阵与字段分派各自独立成 ADDED requirement），归档后主 spec 不再触发这两条 >500 字符 warning；「429 不冷却不轮换」「Provider 重试策略」未触及，不在本次范围。

## Risks / Trade-offs

- **档位表变更会改变用户可见选择器**（glm-5.2 出现 xhigh/minimal 等）：这是修正而非回归，README 需同步说明。
- **kimi-k3 的 `none`**：文档参数表无 `none`，仅 `thinking:"disabled"`。静态表 `efforts` 不含 `none`；宿主选 `none` 时若目录/静态表不含，按第 5 条「不发送」处理会无法关思考 —— 故 kimi-k3 特例：`none` 映射为 `thinking: "disabled"` + 不发 `reasoning_effort`（spec scenario「glm-5.2 禁发 thinking」同款思路已在字段分派 requirement 中覆盖 glm；kimi 的该行为在 spec「内置模型档位表」中以括号注明）。**前提假设**：文档 §八·1 对 kimi `none` 自相矛盾（参数表无、思考强度表有），本设计按「`thinking:"disabled"` 可关」落地，留待实测修正。
- **实测依赖**：§八·9（kimi `max_tokens` 是否硬报错）不影响本设计——无论软硬，改发 `max_completion_tokens` 都是正确行为。

## Migration Plan

无配置迁移。用户可见变化：glm-5.2/kimi-k3 默认档标注从（错误的）`high` 修正为 `max`；deepseek-v4-pro 若曾出现在选择器（依赖目录返回）将由目录决定，静态表不再兜底。

## Open Questions

- kimi-k3 `reasoning_effort: "none"` 与 `thinking: "disabled"` 的真实行为（§八·1）——已在 design 标注为前提假设，实测后修正。
- glm-5.2 流式 usage 是否随流返回（§八·6）——不影响「不发 stream_options」的决策，仅影响用量展示，属后续验证项。
