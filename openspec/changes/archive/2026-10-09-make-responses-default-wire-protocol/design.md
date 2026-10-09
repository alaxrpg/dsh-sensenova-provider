# Design: make-responses-default-wire-protocol

## Context

本系列主体变更（规划 §五 + §6.1/6.5/6.6/6.7），版本 `0.2.0-alpha.2`。数据与决策表来源：规划文档 §五（三模式+决策表+400 兜底+协议纪律）；字段语义对照 /tmp/sn_docs_zh.md :2937-3452（Responses 段原表）。依赖 `add-model-facts` 落地（消费 responsesDefaultEffort/supportedWires/responsesMaxOutputTokens，不重复定义）。

## Goals / Non-Goals

- Goals：wireProtocol 三模式与 resolveWirePlan；Responses 请求体/SSE 翻译/usage 映射；协议纪律与 wire 粘性；400 运行时兜底；设置页两下拉与能力损失提示。
- Non-Goals：多模态图像块（add-multimodal-input，本变更 input_image 仅留接口位）；Anthropic Messages 协议（本期不做）；不修改 Chat 出站语义（body-chat 迁移属本变更文件划分，但字段分派逻辑已在 align-request-fields-with-docs 定稿）。

## 前提假设（实测推翻时的修正路径）

规划 §八 明确以下矛盾/未知**不得当既定事实**，本设计以其成立为地基：

1. **§八·8（决策表地基）**：Responses 下非 `none` 的 `reasoning.effort` 无效。→ 若实测有效（用 `output_tokens_details.reasoning_tokens` 对比 none/high 两次调用），**决策表第 3 条重写**为「偏离档位直接 Responses 传值」，spec「协议降级判定」第 (3) 条与「能力损失提示·档位失效」同步修订。
2. **§八·12**：Responses 下历史 assistant 是否需回放 reasoning 项未知。→ 初版不回放；若实测 400 或工具链断，`toResponsesInput()` 增加 reasoning 项回放（对齐 Chat 路径 requiresReasoningReplay 分派）。
3. **§八·11**：`input_tokens` 是否已含 `cached_tokens` 未知。宿主 `TokenUsage.inputTokens` 语义是未缓存输入（`prompt − cached`）。→ 初版按「已含」处理（不重复扣减）；若实测未含，usage.ts 改为 `input_tokens − cached_tokens`。**列为待实测假设**。
4. **§八·1**：kimi-k3 `none` 档语义（与 align 变更同一假设，`reasoning:{effort:"none"}` 可关）。
5. **§八·4/5**：truncation/include 未列参数表、max_output_tokens 范围表漏 deepseek-flash → 纪律按「绝不发送」处理、钳制值对 deepseek-flash 用保守缺省（responsesMaxOutputTokens 缺省回退 outputLimitMax）。
6. **§八·14**：sequence_number 严格性与并行 output_index 稳定性未知 → 解析不依赖 sequence_number，仅按 item_id/output_index 分桶；若实测乱序再引入序号校验。

## Decisions

1. **分派点在 `stream()` 内**（宿主 LlmAdapter 无 wire 抽象）：`factsFor → resolveWirePlan → buildBody(wire) → fetch(pathFor(wire))`，轮换/429/退避/看门狗管线不动（规划 §6.1）。
2. **三模式语义按 §5.1 原文**：auto 无感知降级；responses 报错不回退；chat-completions 零回归通道，**永久保留不设移除时间表**（规划 §十·5）。
3. **「省略优于传无效值」**：非 none 的 reasoning.effort 在 Responses 上是空操作就不发；只有偏离默认或关闭思考才需要 Chat 或显式 none（§5.2 判定表逐行入 spec 场景）。
4. **协议纪律照官方 Codex 配置**（disable_response_storage=true 规避 previous_response_id 400）：禁发五字段 + 不发 stop + 不等 [DONE] + 多轮全本地 + tools 仅 function + call_id 体系（§5.4/§6.5）。
5. **wire 粘性**：选定后整次请求不切换，防混合历史与 id 体系串扰；400 兜底是唯一例外且必须在内容流出前（§6.1 关键约束）。
6. **SSE 翻译**：output_index 直接复用为宿主 block index（语义顺序一致）；并行 function_call 按 item_id/output_index 分桶拼接；finish 扫 output[] 含 function_call 判 tool-calls（§6.6 映射表全量入 spec）。
7. **文件划分按规划 §6.3**：`src/wire/{types,facts,plan,body-chat,body-responses,sse-responses,usage,blocks}.ts`；facts 由 add-model-facts 提供，本变更只消费。
8. **设置注入点按 scout 清单 settings.ts 六处**；控件复用 section.tsx:296 既有模式；locales 双语；customizedCount 同步。能力损失五类提示文案入 spec。

## Risks / Trade-offs

- **auto 默认改变出站协议**（temperature 默认 0.6 vs 1、max_output_tokens 含推理 token）：以能力损失提示 + chat-completions 逃生舱兜底。
- **文档三处自相矛盾**（§八·1/2/3）：以 §5.3 运行时 400 兜底为安全网——文档错了只退化为「该模型走 Chat」，不退化为不可用。
- **坏历史重放 400**：Chat 路径四条防御（空 name 丢弃/arguments 补 {}/id 合成/孤立 tool-result 丢弃）必须复制到 Responses input 构造。

## Migration Plan

无配置迁移：旧配置无 `wireProtocol` 字段视为 `auto` 默认值。上线前建议先做 §八·8 实测（两次真实调用，凭据由用户执行）验证决策表地基。

## Open Questions

- §八·13：reasoning.summary 三档实际摘要长度与形态（初版只透传枚举值）。
- §八·6：glm-5.2 流式 usage 是否返回（本变更 glm 走 Responses 后由 SSE usage 事件覆盖，缺失时 usage 块缺省）。
