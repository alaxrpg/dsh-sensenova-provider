# Design: add-model-facts

## Context

本变更是 `docs/sensenova-upgrade-plan.md` §6.2 的落地：在 align-request-fields-with-docs（字段值修正，已起草）与 make-responses-default-wire-protocol（协议切换）之间插入一个纯数据抽象层。数据源与 align-request-fields-with-docs 完全一致（/tmp/sn_docs_zh.md），起草时已逐项对照，无数值冲突（档位矩阵：6.8/v4-flash low/medium/high/max/none 默认 high；deepseek-flash 原生 none/low/high/max 默认 high + 兼容映射；glm-5.2 七档默认 max；kimi-k3 low/medium/high/max 默认 max；deepseek-v4-pro 移除；kimi 输出上限字段 max_completion_tokens；supportsStreamOptions 除 glm-5.2 均为 true）。

## Goals / Non-Goals

- Goals：ModelFacts 接口全字段；静态档案表；`factsFor(model, catalog)` 合并；`KNOWN_EFFORTS` 等常量迁入 `src/facts.ts`；测试锁定「迁移后出站行为不变」。
- Non-Goals：不改 Chat 出站行为（align-request-fields-with-docs 范围）；不实现 resolveWirePlan/Responses 消费方（后续变更，本变更只保证字段存在且语义稳定）；不实现图像输入（supportsImages 等字段先落 false/空，值由 add-multimodal-input 填）。

## Decisions

1. **合并优先级：目录实测 > 静态档案**。目录是运行时真值（context_length/max_output_length/input_modalities/supported_sampling_parameters）；静态档案只是无目录时的兜底与 Responses 阶段数据的落点。
2. **单抽象双消费**：ModelFacts 同时是 Chat 字段裁剪（efforts/outputLimitField/forbidThinkingDisabled/fixedTemperature/fixedTopP/supportsStreamOptions）与 wire 决策（resolveWirePlan 消费 responsesDefaultEffort/supportedWires）的唯一数据源，字段一次定义、两处消费，禁止在 adapter 里再造平行表。
3. **静态表数值=align-request-fields-with-docs 的机器可读化**。起草时逐项对照：无冲突。约定后续两变更任一方修改档位矩阵时，必须同步另一方（以 /tmp/sn_docs_zh.md 为最终裁判）。
4. **未知字段保守缺省**：responsesDefaultEffort 暂等于 defaultEffort；responsesMaxOutputTokens 暂等于 outputLimitMax；responsesSupportsJsonSchema 全 false；supportedWires 全部初始为 `["chat-completions"]`（Responses 支持由 make-responses-default-wire-protocol 按探测结果改写）；fixedTemperature/fixedTopP 初始无（文档未给出固定值，若实测发现硬编码采样再补）；supportsImages/imageFormats/imageRequiresBase64 初始 false/空/false。缺省值必须是「显式保守」而非遗漏。
5. **requiresReasoningReplay 语义**：仅 deepseek-v4-flash/deepseek-flash 为 true（且按现有行为仅带 tools 时生效——该条件属消费方逻辑，档案只记「需要回放」）；其余 false。
6. **kimi-k3 特例入档案**：outputLimitField=`max_completion_tokens`，outputLimitMax 记「1M − prompt 长度」（软上限，实测修正）；`none` 档经 `thinking:"disabled"` 表达的特例由消费方处理，档案 efforts 不含 none。

## Risks / Trade-offs

- 双变更数值漂移风险：以决策 3 的约定 + 测试断言「档案表与 align-request-fields-with-docs 落地后的 KNOWN_EFFORTS 同源」缓解（同一常量迁入后天然同源，测试锁行为）。
- 纯重构回归风险：任务中用「迁移前后请求体快照对比」测试兜底。
- 目录字段名演进：factsFor 对未知目录字段宽容忽略，不因目录新增字段报错。

## Migration Plan

无用户可见迁移。`KNOWN_EFFORTS` 迁入 `src/facts.ts` 后 `src/adapter.ts` 改为 re-export/引用，git 历史可追溯；对外 API 无变化。

## Open Questions

- 各模型 responsesMaxOutputTokens 实际上限（Responses 协议探测后填）。
- fixedTemperature/fixedTopP 是否存在硬编码采样模型（暂无从文档确认，留实测）。
