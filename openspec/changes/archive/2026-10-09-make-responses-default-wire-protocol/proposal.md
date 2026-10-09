# Proposal: make-responses-default-wire-protocol

## Why

SenseNova 网关的 Responses 协议已双向探测证实可用（规划 §二），且推理档位在 Responses 下语义更完整（`none` 可显式关闭）；当前插件只走 Chat Completions，无法兑现。这是本系列的主体变更：在 `add-model-facts` 的能力档案之上，把插件默认 wire 切换为 Responses，同时保留 Chat 逃生舱与运行时兜底。

## What Changes

- 新增 `wireProtocol` 配置三模式：`auto`（默认，优先 Responses，语义损失时降级 Chat）/ `responses`（强制，不能保真即报错）/ `chat-completions`（逃生舱，行为不变）。
- 新增 `resolveWirePlan` 决策：四条降级判定（stop 非空、模型不在支持集、effort 偏离且非 none、运行时 400 标记），「省略优于传无效值」。
- 新增 Responses 请求体构造与 SSE 事件流翻译（`output_index` 复用为宿主 block index、`call_id` 作 ToolCallId）。
- 协议纪律：绝不发送 store/background/previous_response_id/truncation/include；不发 stop；不等待不识别 `[DONE]`。
- wire 请求内粘性：wire 选定后整次请求（含账号轮换重试）不切换；400 兜底重试是唯一例外且在任何内容流出前。
- 运行时兜底：Responses 返回 400 `invalid_request_error` → 进程内标记该模型、立即改用 Chat 重试一次。
- 设置页新增 `wireProtocol` 与 `reasoningSummary` 两个下拉（复用现有控件模式，双语，customizedCount 同步）；档位失效等场景给出能力损失提示。

## Capabilities

- **New Capabilities**: 无
- **Modified Capabilities**: `sensenova-provider`（新增协议选择、降级判定、请求纪律、事件流映射、运行时兜底、设置界面等 requirement；不修改主 spec 现有 requirement）

## Impact

- 代码：新增 `src/wire/`（plan/body-responses/sse-responses/usage 等，按规划 §6.3 文件划分）；`stream()` 内分派；设置页与 locales 双语；消费 `add-model-facts` 的 responsesDefaultEffort/supportedWires/responsesMaxOutputTokens（不重复定义）。
- 行为变化：auto 模式下多数请求出站协议从 Chat 变为 Responses（temperature 默认 0.6 vs Chat 1、max_output_tokens 含推理 token）——以能力损失提示告知；chat-completions 模式零变化。
- 前提依赖：`add-model-facts` 落地（ModelFacts 抽象）。
