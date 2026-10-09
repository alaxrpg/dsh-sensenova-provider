# Tasks: make-responses-default-wire-protocol

实现者视角，逐条可验证。验收命令：`npx tsc --noEmit`、`npm test`、`npm run build`。依赖：add-model-facts 已落地（ModelFacts 可用）。

## 1. 协议决策（src/wire/plan.ts）

- [x] 1.1 新增 `WireProtocol`/`WirePlan`/`WireReason` 类型；`wireProtocol` 配置项三值，缺省 `auto`
- [x] 1.2 `resolveWirePlan(options, config, modelFacts)`：四条降级判定（stop 非空 / supportedWires 不含 responses / effort 非 none 且非 responsesDefaultEffort / 运行时 400 标记）；`responses` 模式命中即抛带切换说明的错误；返回 `{wire, reason}` 供日志
- [x] 1.3 单测：§5.2 判定表五行逐行覆盖（none 显式发、偏离降级、等于默认不发 reasoning、未选不发）；三模式 × 四条件矩阵

## 2. Responses 请求体（src/wire/body-responses.ts）

- [x] 2.1 `toResponsesInput()`：system→instructions；user/assistant 文本→input_text/output_text；tool-call→function_call（call_id）；tool-result→function_call_output；套用四条坏历史防御（空 name 丢弃、arguments 补 `{}`、空 id 合成、孤立 tool-result 丢弃）
- [x] 2.2 字段映射：maxTokens→max_output_tokens 按 responsesMaxOutputTokens 钳制（缺省回退 outputLimitMax）；temperature 仅显式设置才发；reasoning.effort 仅 none 时发；reasoning.summary 按配置（默认 auto）；stream 恒 true；tools 扁平 function 形态
- [x] 2.3 协议纪律断言测试：任意输入生成的请求体永不含 store/background/previous_response_id/truncation/include/stop
- [x] 2.4 单测：system/input 映射、钳制、坏历史清洗四场景（对照 spec「Responses 请求体映射」）

## 3. SSE 翻译（src/wire/sse-responses.ts）

- [x] 3.1 事件映射：output_item.added→block-start（output_index 为 block index）；reasoning_summary_text.delta→推理增量；output_text.delta→文本增量；function_call_arguments.delta→tool-call-delta（call_id 为 ToolCallId）；output_item.done→block-end
- [x] 3.2 finish 判定：completed（扫 output[] 含 function_call → tool-calls，否则 stop）；incomplete（max_output_tokens→max-tokens；content_filter→error）；failed→error；不等待不识别 [DONE]
- [x] 3.3 并行工具调用按 item_id/output_index 分桶拼接缓冲
- [x] 3.4 usage（src/wire/usage.ts）：input/output/total 直取；cached_tokens→cacheReadTokens；reasoning_tokens→reasoningTokens；input_tokens 含缓存与否按 design 假设 3 初版处理并留 TODO 标注实测点
- [x] 3.5 单测：事件序列回放夹具（含并行 function_call 交错、incomplete 两种 reason、failed）

## 4. 接线与兜底（src/adapter.ts）

- [x] 4.1 `stream()` 分派改造：factsFor→resolveWirePlan→buildBody(wire)→fetch(pathFor(wire))；轮换/429/退避/看门狗管线不动；Chat 分支迁至 body-chat.ts（行为不变）
- [x] 4.2 wire 粘性：整次请求（含轮换重试）不切换 wire；单测覆盖 401 轮换后仍同 wire
- [x] 4.3 400 兜底：Responses 400 + error.type=invalid_request_error 且无内容流出 → 记进程内 `responsesUnsupported` 集合 + 日志，同请求换 Chat 重试一次；后续该模型直连 Chat；不持久化；单测覆盖即时切换/后续直连/重启清空三场景
- [x] 4.4 chat-completions 模式回归测试：现有请求体/流解析快照与迁移前一致

## 5. 设置页与文案

- [x] 5.1 按 scout 清单 settings.ts 六处注入 `wireProtocol` 与 `reasoningSummary` 配置；控件复用 section.tsx:296 模式；customizedCount 同步
- [x] 5.2 locales 中英双语文案（含五类能力损失提示：档位失效降级、思维链降级摘要、stop 不生效降级、max_output_tokens 含推理 token、temperature 默认 0.6 差异）
- [x] 5.3 手动验证（或组件测试）：两下拉保存生效、语言切换、提示文案展示

## 6. 收口验证

- [x] 6.1 `openspec validate make-responses-default-wire-protocol --strict` 通过
- [x] 6.2 `npx tsc --noEmit`、`npm test`、`npm run build` 通过；git diff 复核无越界写入（src/wire/ 新增、adapter/settings/locales 修改、测试）
- [x] 6.3 上线前实测清单移交用户：§八·8（决策表地基）、§八·11（usage 扣减）、§八·12（reasoning 回放）—— 凭据操作由用户执行

## 实现证据（wire-builder，2026-10-09）

- 决策/请求体/SSE/usage：src/wire/plan.ts、src/wire/body-responses.ts、src/wire/sse-responses.ts、src/wire/usage.ts（body-chat.ts 为 4.1 自 adapter.ts 迁出，行为不变）
- 接线与兜底：src/adapter.ts stream() 分派（wire 粘性 + responsesUnsupported 400 兜底）
- 设置页：src/client/settings.ts、src/client/section.tsx、src/client/locales.ts（双语 + 五类能力损失提示）
- 配置面：src/index.ts（wireProtocol/reasoningSummary schema 与归一化）
- 测试：tests/wire-responses.test.ts（29 用例：判定表/请求体/协议纪律/SSE 序列含并行交错与 incomplete/failed/断尾/usage/端点分派/400 兜底三场景/401 轮换同 wire/chat 强制零回归）、tests/settings.test.ts 新增 2 用例（staged 保存热生效 + 双语键）；tests/adapter.test.ts CONNECTION 钉 chat-completions 保旧断言零回归
- 验收：pnpm exec tsc --noEmit 0 错误；pnpm test 140/140；pnpm run build 成功（256.35 kB）；openspec validate make-responses-default-wire-protocol --strict 通过（npm 不可用环境改用 npx --yes openspec / pnpm 等价命令）
- 6.3 实测清单移交：§八·8 Responses 档位语义、§八·11 input_tokens 是否已含 cached_tokens（src/wire/usage.ts 有 TODO 标注）、§八·12 Responses 历史不回放 reasoning 项——均需真实凭据，由用户执行
