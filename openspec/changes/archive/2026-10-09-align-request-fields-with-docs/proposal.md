# Proposal: align-request-fields-with-docs

## Why

插件当前的 Chat Completions 请求构造与官方文档（`/tmp/sn_docs_zh.md` 逐节原表核对）存在系统性偏差：推理档位表几乎全错（用户给 glm-5.2 选 `high` 实际按 `max` 跑、持续多计费）、kimi-k3 输出上限字段名用错、多轮思维链回传未按模型分派、不支持字段未按模型裁剪（glm-5.2 收到 `thinking.type=disabled` 会直接失败）。这些问题不依赖任何新抽象即可修复，属于纯 bug 修正，收益最直接、风险最低。

## What Changes

- **修正内置模型族档位表**（P0-1）：`sensenova-6.8-flash-lite` 补 `max`（low/medium/high/max/none，默认 high）；`deepseek-v4-flash` 补 `max`（low/medium/high/max/none，默认 high）；新增 `deepseek-flash`（原生 none/low/high/max，默认 high；兼容映射 minimal→low、medium/xhigh→high、ultra→max）；`glm-5.2` 改为 max/xhigh/high/medium/low/minimal/none 七档且默认 `max`；`kimi-k3` 补 `medium`（low/medium/high/max，默认 `max`）；移除已不在文档阵容中的 `deepseek-v4-pro` 条目
- **补充 `defaultEffort`**（P1-1）：静态表命中时随 `reasoning.efforts` 一并声明 `reasoning.defaultEffort`，用户可见「当前默认档」
- **kimi-k3 输出上限字段名**（P0-3）：kimi-k3 的输出上限改用 `max_completion_tokens`，其余模型维持 `max_tokens`
- **显式发送 `stream_options`**（P0-4）：流式请求对支持该字段的模型显式发送 `{include_usage: true}`；glm-5.2 参数表无此字段，不发送
- **按模型回放历史思维链**（P0-5）：deepseek-v4-flash / deepseek-flash 携带 `tools` 时回放全部历史轮次 `reasoning_content`；不带 `tools` 或 6.8/glm/kimi 系模型不回传
- **按目录裁剪请求字段**（P0-6）：以目录 `supported_sampling_parameters` 为依据裁剪出站请求字段；glm-5.2 绝不发送 `thinking`（`disabled` 会直接失败）；kimi-k3 不发送 `frequency_penalty`/`presence_penalty`/`temperature`/`top_p`（文档标注固定值、建议不传）
- **文档卫生**：README 中 429 重试相关描述修正、根目录 `debug_*.mjs` 临时脚本清理（列为独立任务条目）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `sensenova-provider`: 修改「模型能力自动配置」（档位表修正 + defaultEffort 声明 + 移除 deepseek-v4-pro）与「流式生成」（请求体构造纪律：字段名分派、stream_options、思维链回放、按模型裁剪）两条 requirement；顺带将触及的超长 requirement 文本拆分至 500 字符内

## Impact

- 代码：`src/adapter.ts`（`KNOWN_EFFORTS` 静态表、`reasoningInfoFrom()`、`buildOpenAiBody()`、`toOpenAiMessages()`）
- 测试：现有 adapter 测试用例需按新档位矩阵与字段分派规则更新，并新增覆盖各分派分支
- 文档：`README.md` 429 描述修正；根目录 `debug_*.mjs` 清理
- 兼容性：用户可见行为变化——glm-5.2/kimi-k3 档位选择器出现新档位且默认档标注修正（原错误标注 high 实为 max）；无 wire 协议变化
- 依据：`docs/sensenova-upgrade-plan.md` §三矩阵、§四 P0-1/3/4/5/6 + P1-1；官方文档原文 `/tmp/sn_docs_zh.md`（关键值已二次抽查：:476、:1297、:1330、:1673、:2022、:2143、:2403、:2446、:1411-1412、:1790-1791、:2539）
