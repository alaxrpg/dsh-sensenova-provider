# Delta Spec: make-responses-default-wire-protocol

## ADDED Requirements

### Requirement: 协议模式选择

系统 SHALL 提供配置项 `wireProtocol`，取值 `auto`/`responses`/`chat-completions`，默认 `auto`。`auto` 优先使用 Responses 协议，仅当该请求会因 Responses 丢失语义时改用 Chat Completions；`responses` 强制使用 Responses，遇到无法保真的请求 MUST 报错并说明切换方法，不得静默回退；`chat-completions` MUST 完整保持既有 Chat 行为。协议选定后整次请求（含账号轮换重试）MUST NOT 切换协议；运行时不支持兜底是唯一例外，且 MUST 发生在任何内容流出之前。

#### Scenario: 默认 auto

- **WHEN** 用户未配置 `wireProtocol`，发起一个 Responses 可保真的请求
- **THEN** 该请求走 Responses 协议，无需用户知情

#### Scenario: 强制模式报错

- **WHEN** `wireProtocol=responses` 且请求命中任一降级判定（如 `stop` 非空）
- **THEN** 请求失败并返回明确错误说明原因与切换到 `auto`/`chat-completions` 的方法，不静默降级

#### Scenario: wire 请求内粘性

- **WHEN** 一次生成请求因 401/429 触发账号轮换重试
- **THEN** 重试仍使用同一协议与同一请求体映射，不出现协议混合

### Requirement: 协议降级判定

系统 SHALL 在每次生成请求前执行协议决策，命中下列任一条件时改用 Chat Completions（`responses` 模式下改为报错）：(1) `options.stop` 非空——Responses 无 `stop` 字段；(2) 模型不在 Responses 支持集（消费 ModelFacts 的 `supportedWires`）；(3) 用户 `reasoningEffort` 既非 `none` 又非该模型 Responses 默认档（消费 `responsesDefaultEffort`）——传了也无效，只有 Chat 能兑现显式选择；(4) 该模型已被运行时标记为 Responses 不可用。未命中时若用户选档等于默认档或未选档，MUST NOT 发送 `reasoning` 字段（省略优于传无效值）；用户选 `none` 时 MUST 显式发送 `reasoning:{effort:"none"}`。

#### Scenario: stop 非空降级

- **WHEN** 请求携带非空 `stop`
- **THEN** 使用 Chat Completions（`auto`）或报错（`responses`）

#### Scenario: 档位偏离默认降级

- **WHEN** 模型 Responses 默认档为 `max`，用户显式选择 `high`
- **THEN** `auto` 模式降级 Chat 并按 `high` 出站；用户选择等于默认档 `max` 时走 Responses 且不发送 `reasoning` 字段

#### Scenario: 显式关闭思考

- **WHEN** 用户选择 `none`
- **THEN** 走 Responses 且请求体含 `reasoning:{effort:"none"}`，真实关闭推理

#### Scenario: 模型不在支持集

- **WHEN** ModelFacts 的 `supportedWires` 不含 `responses`
- **THEN** 该请求走 Chat Completions

### Requirement: Responses 请求纪律

Responses 请求 MUST NOT 携带 `store`/`background`/`previous_response_id`/`truncation`/`include` 字段；MUST NOT 发送 `stop`；流式解析 MUST NOT 等待或识别 `data: [DONE]`，以 `response.completed`/`response.incomplete`/`response.failed` 事件收尾；多轮历史 MUST 全部由本地 `input` 数组携带；`tools` 仅使用 `type:function` 形态（扁平 name/description/parameters）。工具调用标识 MUST 以 Responses 的 `call_id` 作为宿主 ToolCallId，回传结果时原样作 `function_call_output.call_id`。

#### Scenario: 禁发字段

- **WHEN** 构造任意 Responses 请求体
- **THEN** 请求体不含 store/background/previous_response_id/truncation/include/stop 任一字段；历史由 input 数组完整携带

#### Scenario: 流收尾

- **WHEN** Responses SSE 流结束
- **THEN** 解析以 response.completed/incomplete/failed 之一收尾并映射对应 finish 块，全程不依赖 [DONE]

#### Scenario: 工具标识跨轮稳定

- **WHEN** 一轮工具调用与结果回传
- **THEN** ToolCallId 取自 `call_id`，下一轮回传的 `function_call_output.call_id` 与之逐字相同

### Requirement: Responses 请求体映射

系统 SHALL 将生成参数映射为 Responses 请求体：`system` 映射为 `instructions`；用户/助手文本与工具调用/结果按角色映射为 `input[]` 各类型项；`maxTokens` 映射为 `max_output_tokens` 并按 ModelFacts 的 `responsesMaxOutputTokens` 钳制（含推理 token）；`temperature` 仅在用户显式设置时发送（未设时采用 Responses 默认 0.6，区别于 Chat 的 1）；`reasoning.effort` 仅在用户选 `none` 时发送；`reasoning.summary` 按配置（默认 `auto`，可选 `concise`/`detailed`）。现有 Chat 路径对坏历史的防御逻辑（空 name 工具调用丢弃、arguments 空串补 `{}`、空 id 合成、孤立工具结果丢弃）MUST 同样套用于 `input[]` 构造。

#### Scenario: system 与输入映射

- **WHEN** 请求含 system 提示与多轮消息
- **THEN** system 进入 `instructions`，其余消息按角色映射为 input_text/output_text/function_call/function_call_output 项

#### Scenario: 输出上限钳制

- **WHEN** 用户 `maxTokens` 超过该模型 `responsesMaxOutputTokens`
- **THEN** 发送值被钳制到上限，不产生 400

#### Scenario: temperature 显式才发

- **WHEN** 用户未设置 temperature
- **THEN** 请求体不含 temperature 字段，服务端按 Responses 默认 0.6 执行

#### Scenario: 坏历史防御

- **WHEN** 历史含空 name 工具调用或孤立工具结果
- **THEN** input[] 构造按 Chat 路径同款规则清洗，不因重放坏历史而 400

### Requirement: Responses 事件流映射

系统 SHALL 将 Responses SSE 事件翻译为宿主流块：`output_item.added`/`output_item.done` 对应块开始与块结束（`output_index` 复用为宿主 block index）；`reasoning_summary_text.delta`、`output_text.delta`、`function_call_arguments.delta` 对应推理/文本/工具调用增量（工具调用标识取 `call_id`）；`response.completed`/`incomplete`/`failed` 对应 finish 终态。并行工具调用的增量 MUST 按项分别维护拼接缓冲；usage 的缓存与推理 token MUST 分别取自对应 details 字段。

#### Scenario: 事件到流块

- **WHEN** 流中依次出现 output_item.added、若干 delta、output_item.done
- **THEN** 宿主收到同 index 的块开始/增量/块结束序列，index 与服务端 output_index 一致；reasoning_summary_text.delta → 推理增量、output_text.delta → 文本增量、function_call_arguments.delta → 工具调用增量（标识为 call_id）

#### Scenario: 并行工具调用拼接

- **WHEN** 多个 function_call 的 arguments 增量交错到达
- **THEN** 各调用按 item_id/output_index 独立缓冲，最终 arguments 拼接完整不串扰

#### Scenario: 完成与截断判定

- **WHEN** 流以 response.completed 收尾且 output[] 含 function_call 项
- **THEN** finish 为 tool-calls（不含则为 stop）；response.incomplete 且 reason=max_output_tokens 时 finish 为 max-tokens、reason=content_filter 时为 error；response.failed 为 error（带 error）

#### Scenario: usage 映射

- **WHEN** response.completed 携带 usage
- **THEN** input_tokens/output_tokens/total_tokens 直取；input_tokens_details.cached_tokens → 缓存读取 token；output_tokens_details.reasoning_tokens → 推理 token

### Requirement: 运行时协议兜底

系统 SHALL 维护进程内 Responses 不可用模型集合：Responses 对某模型返回 HTTP 400 且 `error.type === 'invalid_request_error'` 时，将该模型记入集合并记录一条说明日志，本次请求 MUST 在任何内容流出之前立即改用 Chat Completions 重试一次，后续该模型请求直接走 Chat。该集合 MUST NOT 持久化或写入用户配置。

#### Scenario: 400 即时切换

- **WHEN** Responses 请求返回 400 invalid_request_error 且尚无内容流出
- **THEN** 同一请求改用 Chat 重试一次，用户不感知协议切换

#### Scenario: 后续请求直连 Chat

- **WHEN** 某模型已被记入不可用集合
- **THEN** 后续该模型请求不再尝试 Responses，直接走 Chat

#### Scenario: 进程内不持久化

- **WHEN** 插件进程重启
- **THEN** 不可用集合为空，重新按决策表尝试 Responses

### Requirement: 协议设置界面

设置页 SHALL 提供 `wireProtocol`（自动/强制 Responses/仅 Chat Completions）与 `reasoningSummary`（自动/简洁/详细）两个下拉控件，复用现有设置控件模式，中英双语文案，并与自定义计数同步。当用户选择会触发能力损失时 MUST 给出提示：档位在 Responses 下不生效（降级 Chat 兑现）、思维链降级为摘要、`stop` 不生效（降级 Chat）、`max_output_tokens` 含推理 token、未设 temperature 时 Responses 默认 0.6（区别于 Chat 的 1）。

#### Scenario: 协议与摘要配置

- **WHEN** 用户在设置页选择 wireProtocol 与 reasoningSummary
- **THEN** 两个下拉保存生效，界面语言切换时文案随之切换，自定义计数同步

#### Scenario: 能力损失提示

- **WHEN** 用户选择 responses 或 auto 模式且查看档位/停止词等设置说明
- **THEN** 界面展示上述五类能力损失提示，说明对应的降级或行为差异
