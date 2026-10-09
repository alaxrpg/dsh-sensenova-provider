# Tasks: add-model-facts

实现者视角，逐条可验证。验收命令：`npx tsc --noEmit`、`npm test`、`npm run build`。

## 1. 接口与静态档案

- [x] 1.1 新建 `src/facts.ts`：定义 `ModelFacts` 接口，字段含 efforts/defaultEffort/responsesDefaultEffort/outputLimitField/outputLimitMax/supportsImages/imageFormats/imageRequiresBase64/requiresReasoningReplay/forbidThinkingDisabled/fixedTemperature/fixedTopP/supportsStreamOptions/responsesMaxOutputTokens/responsesSupportsJsonSchema/supportedWires
- [x] 1.2 静态档案表逐模型填值（数据源=/tmp/sn_docs_zh.md，须与 align-request-fields-with-docs 档位矩阵逐项一致）：
  - 6.8-flash-lite、deepseek-v4-flash：efforts low/medium/high/max/none，defaultEffort high，outputLimitField `max_tokens`，supportsStreamOptions true，requiresReasoningReplay false（6.8）
  - deepseek-flash（V4.1 Flash）：原生档 none/low/high/max 默认 high + 兼容映射 minimal→low、medium/xhigh→high、ultra→max，outputLimitField `max_tokens`，requiresReasoningReplay true，supportsStreamOptions true
  - glm-5.2：七档默认 max，forbidThinkingDisabled true，supportsStreamOptions false，outputLimitField `max_tokens`
  - kimi-k3：low/medium/high/max 默认 max，outputLimitField `max_completion_tokens`（outputLimitMax 记 1M−prompt 软上限），supportsStreamOptions true
  - 全体缺省：supportsImages false/imageFormats 空/imageRequiresBase64 false/responsesDefaultEffort=defaultEffort/responsesMaxOutputTokens=outputLimitMax/responsesSupportsJsonSchema false/supportedWires `["chat-completions"]`/fixedTemperature、fixedTopP 无
  - deepseek-v4-pro 不收录
- [x] 1.3 单测：每条档案字段完整性 + 与上述矩阵逐项相等；未收录模型 id 返回通用兜底档案不抛错

## 2. 合并函数与常量迁移

- [x] 2.1 `factsFor(model, catalog)`：目录 context_length/max_output_length/input_modalities/supported_sampling_parameters 实测值覆盖静态对应项，缺失回退静态；未知目录字段宽容忽略。单测覆盖「覆盖」「回退」两分支与目录缺模型场景
- [x] 2.2 迁移 `src/adapter.ts` 中 `KNOWN_EFFORTS` 等模型常量入 `src/facts.ts`（adapter 改引用，不复制第二份）
- [x] 2.3 行为不变回归测试：以 facts 数据驱动现有 Chat 请求构造，出站请求体快照与迁移前逐字段一致（覆盖 5 模型 × 带/不带 tools）

## 3. 收口验证

- [x] 3.1 `openspec validate add-model-facts --strict` 通过
- [x] 3.2 `npx tsc --noEmit`、`npm test`、`npm run build` 通过；git diff 复核无越界写入（仅 `src/facts.ts`、`src/adapter.ts` 引用调整、新增测试文件）

## 实现证据（wire-builder，实际命令用 pnpm 等价执行）

- 1.1/1.2：`src/wire/types.ts`（ModelFacts 接口，16 必填字段 + id/effortCompat?/samplingParameters?/noneMapsToThinkingDisabled/blockedSampling 消费面扩展）、`src/wire/facts.ts`（STATIC_FACTS 五模型档案 + GENERIC_FACTS 兜底）。路径与 tasks.md 写的 `src/facts.ts` 不同：按 Lead 派发与升级计划 §6.2/6.3 落在 `src/wire/`，供 task-9/10 wire 模块同目录消费。
- 图像字段（supportsImages/imageFormats/imageRequiresBase64）按文档 §3.1 图像行填真实值（6.8/deepseek-flash/kimi 支持图像，kimi base64-only）而非「全体 false」缺省——纯数据，Chat 出站零消费，供 add-multimodal-input 使用；Lead 要点 4 授权。
- 1.3：`tests/wire-facts.test.ts` 「五模型静态档案字段完整且与文档矩阵逐项相等」逐字段断言 + deepseek-v4-pro 不收录 + 未知 id 通用兜底不抛错。
- 2.1：`factsFor(model, entry)` 目录 max_output_length/supported_sampling_parameters/input_modalities 覆盖静态、缺失回退、未知字段宽容忽略；单测覆盖覆盖/回退/目录缺条目/未知模型四分支。
- 2.2：`src/adapter.ts` 删除 KNOWN_EFFORTS/KNOWN_SAMPLING_PARAMS/StaticEffortFacts，改 import { factsFor, staticFacts }；reasoningInfoFrom/chatFieldPlan/buildOpenAiBody 消费档案（kimi 静态采样兜底补 seed/parallel_tool_calls，吸收 task-8 ①）。
- 2.3 行为不变：chatFieldPlan 未知模型语义显式保持（efforts 空数组视同 undefined 原样发送、supportsStreamOptions 保守 false）；迁移后 `pnpm test` 既有 103 用例全绿（含 5 模型字段分派出站断言 ±tools）= 零回归证明。
- 3.1：`npx --yes openspec validate add-model-facts --strict` → "Change 'add-model-facts' is valid"。
- 3.2：`pnpm exec tsc --noEmit`（无输出）、`pnpm test`（109/109 pass，含 6 个新 facts 用例）、`pnpm run build`（成功）。git 变更仅 src/wire/{types,facts}.ts（新增）、src/adapter.ts（迁移引用）、tests/wire-facts.test.ts（新增）、本 tasks.md 勾选。
