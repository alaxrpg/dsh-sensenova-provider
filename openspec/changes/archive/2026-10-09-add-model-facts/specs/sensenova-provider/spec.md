# Delta Spec: add-model-facts

## ADDED Requirements

### Requirement: 模型事实档案

系统 SHALL 维护机器可读的模型事实档案（ModelFacts），每个内置模型族一条记录，字段涵盖档位值域与默认档、Responses 协议数据位、输出上限、图像输入、思维链回放、禁用思考、固定采样参数、流式 usage、Responses 上限与结构化输出、支持的协议集合。档案数值 MUST 与官方文档一致，并作为 align-request-fields-with-docs 所定档位值的机器可读化，两处数值 MUST 一致；`KNOWN_EFFORTS` 等模型常量 SHALL 迁入统一存放，不得存在平行副本。

#### Scenario: 静态档案字段完整

- **WHEN** 读取任一内置模型族的档案记录
- **THEN** 下列字段全部存在（不支持的为空集/false/缺省）：efforts、defaultEffort、responsesDefaultEffort、outputLimitField、outputLimitMax、supportsImages、imageFormats、imageRequiresBase64、requiresReasoningReplay、forbidThinkingDisabled、fixedTemperature、fixedTopP、supportsStreamOptions、responsesMaxOutputTokens、responsesSupportsJsonSchema、supportedWires

#### Scenario: 与档位矩阵一致

- **WHEN** 对照档案与 align-request-fields-with-docs 定义的内置模型档位矩阵
- **THEN** 各模型的档位值域、默认档、输出上限字段名逐项相同（含 kimi-k3 使用 `max_completion_tokens`、deepseek-v4-pro 无条目）

#### Scenario: 未收录模型

- **WHEN** 模型 id 未命中任何内置模型族
- **THEN** 返回不含静态假设的通用档案（空 efforts、无禁发规则），不抛错

### Requirement: 目录实测值优先合并

系统 SHALL 提供 `factsFor(model, catalog)` 合并函数：当目录（List Models 实测）提供 context_length、max_output_length、input_modalities、supported_sampling_parameters 等实测字段时，实测值 MUST 覆盖静态档案对应项；目录未提供的字段回退静态档案值。合并结果同时服务 Chat 请求字段裁剪与后续协议（wire）决策（含 responsesDefaultEffort 与 supportedWires 的消费），且 MUST 不改变现有 Chat 出站请求体的实际行为。

#### Scenario: 目录覆盖静态值

- **WHEN** 目录为某模型返回 max_output_length 或 context_length
- **THEN** 合并结果的输出上限采用目录实测值，静态档案对应项被忽略

#### Scenario: 目录缺失回退静态

- **WHEN** 目录未返回某字段（如模型不在目录中或字段缺省）
- **THEN** 合并结果回退静态档案值，字段语义不变

#### Scenario: 出站行为不变

- **WHEN** 以合并前后的事实数据驱动现有 Chat 请求构造路径
- **THEN** 出站请求体与迁移前逐字段一致（纯重构，无行为变化）
