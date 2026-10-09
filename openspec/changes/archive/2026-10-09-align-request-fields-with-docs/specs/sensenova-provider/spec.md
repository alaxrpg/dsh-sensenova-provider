# sensenova-provider Specification

## MODIFIED Requirements

### Requirement: 模型能力自动配置

系统 SHALL 在 `listModels()` 获取目录后缓存每个模型的能力元数据，并在 `resolveModel()` 中按模型 id 自动生成对应配置：上下文大小优先取目录的 `context_length`、`context_window`、`max_context_length` 或 `contextLength`；最大输出优先取 `max_output_length`、`max_tokens`、`max_output_tokens`、`max_completion_tokens` 或对应驼峰字段（`max_output_length` 为 SenseNova 目录实际字段名，SHALL 优先识别）；输入模态取目录 `input_modalities`。

系统 SHALL 按以下优先级声明思考档位（`reasoning.efforts`）：目录提供档位词表时采用目录词表；否则模型 id 命中内置模型族档位表时采用该表并 SHALL 同时声明对应的 `defaultEffort`；两者皆无时不声明思考档位，SHALL NOT 虚构档位。每个 effort id SHALL 原样保留为 wire value 并包装为宿主 `ReasoningEffortId`（deepseek-flash 的兼容映射除外，见「内置模型档位表」）。

#### Scenario: 按目录配置上下文大小

- **WHEN** `listModels()` 返回某模型的 `context_length` 为 `262144`，随后调用该模型的 `resolveModel()`
- **THEN** 返回的 `context.contextWindow` 为 `262144`，而不是通用的固定默认值

#### Scenario: 按目录配置最大输出

- **WHEN** 目录为某模型声明 `max_output_tokens` 或等价最大输出字段
- **THEN** `resolveModel()` 返回对应的 `defaultMaxTokens`，供宿主自动配置请求上限

#### Scenario: 识别 SenseNova 目录的 max_output_length 字段

- **WHEN** `/models` 目录以 `max_output_length: 65536` 声明某模型（如 `deepseek-v4-flash`）的最大输出，且不含 `max_tokens` 等 OpenAI 风格字段，随后调用该模型的 `resolveModel()`
- **THEN** 返回的 `defaultMaxTokens` 为 `65536`，宿主在用户未显式设置上限时将其作为请求上限下发，模型输出不再受服务端默认上限（8192）截断

#### Scenario: 按目录配置思考级别

- **WHEN** 目录为某模型提供 `reasoning_efforts` 词表 `low`、`medium`、`high`，并声明 `medium` 为默认级别
- **THEN** `resolveModel()` 将相同 wire value 映射到 `reasoning.efforts` 与 `reasoning.defaultEffort`，静态表不参与覆盖

#### Scenario: 目录仅标记支持但未提供词表

- **WHEN** 模型目录只有 `reasoning_effort`、`thinking` 或 `supported_features: ["reasoning"]` 支持标记，没有可选级别词表
- **THEN** 模型 id 命中内置模型族档位表时，`resolveModel()` 返回该表的 `reasoning.efforts` 及其 `defaultEffort`；id 不在表中时保持该项未知，不虚构思考级别

#### Scenario: 目录刷新后同步能力

- **WHEN** 再次调用 `listModels()` 后同一模型的上下文大小或思考档位发生变化
- **THEN** 后续 `resolveModel()` 使用最新目录值（静态表仍按其 id 生效），不继续使用旧缓存

### Requirement: 流式生成

系统 SHALL 以 OpenAI 兼容协议调用 `{apiBase}/chat/completions`，将 SSE 响应翻译为宿主流式块（文本、推理、工具调用、用量、结束），每个出站请求 SHALL 携带 `attributionHeaders()`；当请求因模型不可路由被拒绝时，系统 SHALL 给出明确的模型不可用错误。

系统 SHALL 同时接受 `delta.reasoning_content`（DeepSeek/Kimi 系）与 `delta.reasoning`（SenseNova 6.8 系）作为推理增量，任一字段的增量 SHALL 映射为宿主 reasoning 块增量，不得因字段名差异丢弃思考过程。

系统 SHALL 将 `delta.tool_calls` 分片按 `index` 优先聚合：同一 `index` 的分片归入同一工具槽；无 `index` 但有稳定 `id` 时按 `id` 聚合；两者皆无时按分片出现顺序自增开槽；槽内 `id`/`name` 增量覆盖，`arguments` 增量拼接，聚合结果 `name` 非空且 `arguments` 为完整 JSON 文本。

#### Scenario: 正常流式生成

- **WHEN** 用户以 `sensenova` 路由发起生成请求
- **THEN** 系统向 `{apiBase}/chat/completions` 发送请求，并将 SSE 流翻译为宿主流式块直至 `finish`

#### Scenario: 模型不可路由

- **WHEN** 响应返回 404 且错误信息为 `model route not found` 或 `model is not found`
- **THEN** 系统以明确的模型不可用错误结束本次生成，而非抛出一个无上下文的通用 404

#### Scenario: 流开始后失败不回放

- **WHEN** SSE 已开始输出内容后请求失败
- **THEN** 系统以该错误结束本次生成，不将已消费的生成回放到另一账号

#### Scenario: 透传思考档位

- **WHEN** 宿主为某模型选定 `reasoning_effort`，该值在模型档位表（或目录词表）值域内
- **THEN** 出站请求体包含与选定值一致的 `reasoning_effort`，不做值域改写或丢弃；命中 deepseek-flash 兼容映射（`minimal`→`low`、`medium`/`xhigh`→`high`、`ultra`→`max`）或值域外时按「Chat 请求体字段分派」处理，不发送模型不认识的档位值

#### Scenario: 两种推理增量字段都被显示

- **WHEN** SSE 事件中 `delta.reasoning_content` 或 `delta.reasoning` 任一字段携带文本
- **THEN** 系统将对应文本作为 reasoning 块增量发射；两个字段都有值时按 `reasoning_content` 优先、`reasoning` 兜底，不重复发射

#### Scenario: 规范 index 并行工具分片聚合

- **WHEN** SSE 以带 `index` 的并行 `tool_calls` 分片流式返回多个工具（如 `index 0` 与 `index 1` 各自分片到达）
- **THEN** 经宿主组装后产出与工具数一致的 `tool-call` 块，每个块的 `name` 非空、`arguments` 为该工具完整合法的 JSON 文本，分片不串槽不错位

#### Scenario: 无键并行工具分片聚合

- **WHEN** SSE 的并行 `tool_calls` 分片既无 `index` 也无 `id`，多个工具的分片交错到达
- **THEN** 各工具按出现顺序分入独立槽，经宿主组装后每个 `tool-call` 块 `name` 非空、`arguments` 完整，不出现多工具 arguments 拼接或空 `name` 块

## ADDED Requirements

### Requirement: 内置模型档位表

系统 SHALL 维护内置模型族档位表，值域与默认档以官方文档为准，命中时随 `reasoning.efforts` 声明 `defaultEffort`。各模型具体值域：`sensenova-6.8-flash-lite` 与 `deepseek-v4-flash` 为 `low`/`medium`/`high`/`max`/`none`（默认 `high`）；`deepseek-flash` 原生 `none`/`low`/`high`/`max`（默认 `high`）另按兼容映射接受 `minimal`/`medium`/`xhigh`/`ultra`；`glm-5.2` 为 `max`/`xhigh`/`high`/`medium`/`low`/`minimal`/`none`（默认 `max`）；`kimi-k3` 为 `low`/`medium`/`high`/`max`（默认 `max`，`none` 经 `thinking: "disabled"` 表达）。已下线的 `deepseek-v4-pro` SHALL NOT 保留条目。

#### Scenario: glm-5.2 默认档正确标注

- **WHEN** `resolveModel()` 解析 `glm-5.2` 且目录未提供档位词表
- **THEN** 返回七档 `reasoning.efforts` 且 `defaultEffort` 为 `max`，宿主选择器不再把默认档错误显示为 `high`

#### Scenario: deepseek-v4-pro 条目移除

- **WHEN** 用户或宿主查询 `deepseek-v4-pro` 的模型能力
- **THEN** 该 id 不命中内置档位表，`resolveModel()` 不为其声明档位，除非目录另行提供词表

#### Scenario: deepseek-flash 兼容映射

- **WHEN** 宿主为 `deepseek-flash` 选定 `reasoning_effort` 为 `minimal`、`medium`、`xhigh` 或 `ultra`
- **THEN** 出站请求体的 `reasoning_effort` 分别为映射后的 `low`、`high`、`high`、`max`

### Requirement: Chat 请求体字段分派

系统 SHALL 按模型分派出站 Chat 请求字段：输出上限 kimi-k3 使用 `max_completion_tokens`、其余模型使用 `max_tokens`；流式请求对支持模型显式发送 `stream_options: {include_usage: true}`，glm-5.2 SHALL NOT 发送 `stream_options`；请求携带 `tools` 且模型为 deepseek-v4-flash / deepseek-flash 时 SHALL 回放全部历史轮次 `reasoning_content`，其余模型或无 `tools` 时 SHALL NOT 回传；glm-5.2 SHALL NOT 发送任何 `thinking` 字段；kimi-k3 SHALL NOT 发送 `frequency_penalty`、`presence_penalty`、`temperature`、`top_p`；目录 `supported_sampling_parameters` 未列出的采样字段 SHALL NOT 发送。

#### Scenario: kimi-k3 输出上限字段名

- **WHEN** 用户对 `kimi-k3` 设置输出上限
- **THEN** 出站请求体以 `max_completion_tokens` 携带该值，不发送 `max_tokens`

#### Scenario: 显式 stream_options

- **WHEN** 对 6.8-flash-lite / deepseek-v4-flash / deepseek-flash / kimi-k3 发起流式请求
- **THEN** 请求体显式包含 `stream_options: {include_usage: true}`，流式用量不依赖服务端默认值；对 glm-5.2 发起流式请求时请求体不含 `stream_options` 字段

#### Scenario: deepseek 系带工具时回放思维链

- **WHEN** 对 deepseek-v4-flash 或 deepseek-flash 发起携带 `tools` 的多轮请求，且历史 assistant 消息含 `reasoning_content`
- **THEN** 出站 `messages` 中历史 assistant 项保留 `reasoning_content` 原文；同一请求不带 `tools` 时不携带该字段

#### Scenario: 非 deepseek 系不回传思维链

- **WHEN** 对 6.8-flash-lite / glm-5.2 / kimi-k3 发起多轮请求
- **THEN** 出站历史 assistant 项仅携带 `content` 与工具调用结构，不含 `reasoning_content`

#### Scenario: glm-5.2 禁发 thinking

- **WHEN** 宿主为 glm-5.2 关闭思考（等价 `none`）
- **THEN** 请求体通过 `reasoning_effort: "none"` 表达，不出现任何 `thinking` 字段，请求不因 `thinking.type=disabled` 被网关拒绝

#### Scenario: 按目录裁剪采样字段

- **WHEN** 目录为某模型返回 `supported_sampling_parameters` 且不含某采样字段（如 `seed`），而宿主请求携带了该字段
- **THEN** 出站请求体省略该字段，不发送模型不支持的采样参数
