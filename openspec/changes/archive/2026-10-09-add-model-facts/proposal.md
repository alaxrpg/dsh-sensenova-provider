# Proposal: add-model-facts

## Why

字段分派逻辑（档位、输出上限字段、思维链回放、禁发字段）目前散落在 `src/adapter.ts` 的常量与分支中，后续 Responses 协议切换（`make-responses-default-wire-protocol`）与多模态输入（`add-multimodal-input`）都需要同一份模型能力数据。需要先建立单一的「模型事实（ModelFacts）」抽象，避免三处各自维护互相矛盾的模型知识。

## What Changes

- 新增模型事实接口与静态档案表（内置模型族的机器可读能力档案），数据源=align-request-fields-with-docs 修正后的档位值（与 /tmp/sn_docs_zh.md 一致）。
- 新增 `factsFor(model, catalog)` 合并函数：目录实测值（context_length/max_output_length/input_modalities/supported_sampling_parameters）优先于静态档案。
- 将 `KNOWN_EFFORTS` 等模型相关常量从 `src/adapter.ts` 迁入 `src/facts.ts`。
- **不改变** Chat 请求体的实际出站行为（出站行为修正属 align-request-fields-with-docs；本变更只提供抽象与数据，消费方切换属后续变更）。

## Capabilities

- **New Capabilities**: 无
- **Modified Capabilities**: `sensenova-provider`（新增模型事实档案与合并语义的 requirement；不修改现有 requirement）

## Impact

- 代码：新增 `src/facts.ts`（接口 + 静态表 + factsFor）与对应测试；`src/adapter.ts` 仅做常量迁移引用，行为不变。
- 兼容性：纯内部重构，无用户可见变化；为 resolveWirePlan（后续变更）提供 responsesDefaultEffort/supportedWires 数据位。
