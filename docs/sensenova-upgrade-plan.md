# SenseNova Provider 重构方案（Responses 默认）

> 状态：规划稿 v3（逐条核对原始文档表格后重写，取代 v1/v2）
> 依据：`/tmp/sn_docs_zh.md`（官方文档全文 157KB，逐节读取**原表**，非二手摘要）+ 无凭据路由探测 + 本仓代码勘察
> 结论摘要：SenseNova 网关同时暴露 Chat Completions / Responses / Anthropic Messages 三协议（无凭据路由探测双向证实）。**本方案把 Responses 设为默认 wire 协议**，Chat Completions 降级为「保真回退 + 逃生舱」。核心矛盾：Responses 在请求语义上比 Chat Completions **少三样东西**（思考档位 / 停止序列 / 完整思维链），既然成为默认，这三样必须由插件主动补上。

---

## 一、三协议同时在线（已双向证实）

对 `https://token.sensenova.cn/v1` 用伪造 Key 做路由探测（**未接触任何真实凭据**）：

| 端点 | 方法 | 结果 |
|---|---|---|
| `/v1/chat/completions` | POST | 401 `{"error":{"code":16,"message":"Authorization Not Found"}}` |
| `/v1/responses` | POST | 401 同形 |
| `/v1/messages` | POST | 401 同形 |
| `/v1/models` | GET | 401 |
| `/v1/__nope_zzz`、`/v1/anthropic/v1/messages`、`/v1/beta/responses`、`/v2/responses` | POST | **404 `{"error":{"code":5,"message":"NOT_FOUND"}}`** |
| `/v1/responses` | GET/PUT/DELETE | 404（该端点 POST-only） |

路由层在鉴权层之前区分真实/虚假路径 → **三协议确实由 SenseNova 网关提供**，与官方文档一致。

**本期只做 Responses。** Anthropic Messages 协议文档未给独立支持模型列表（图片块仅注明 6.8-flash-lite），留待后续。

**文档全文的可靠获取方式（供后续复核）：** 整页 `web_fetch` 会在「Kimi K3 → 图像输入」处截断；正文完整内嵌在 Next.js 客户端 chunk `https://platform.sensenova.cn/_next/static/chunks/2582-58d47f3877513ce9.js`（模块 `3076`=英文 md、`82285`=中文 md）。抽取文本已存 `/tmp/sn_docs_zh.md`（157534 字节）与 `/tmp/sn_docs_en.md`（166911 字节）。站内锚点：`#list-models`、`#api-compatibility`、`#api-responses`、`#api-responses-params`、`#api-responses-sse`、`#errors`、`#tools-codex`。

---

## 二、核心矛盾：Responses 作为默认要付出什么

| 维度 | Chat Completions | Responses | 是否丢语义 |
|---|---|---|---|
| **思考档位** | `reasoning_effort` 完整生效 | `low`/`medium`/`high`/`xhigh` **传入无效**，后台固定按模型默认（6.8/v4-flash/v4.1-flash → `high`；glm-5.2/kimi-k3 → `max`）。**只有 `none` 真能关闭** | **是** |
| **停止序列** | `stop` 支持 | 请求参数表**无 `stop` 字段** | **是** |
| **思维链** | `reasoning_content` 原始思维链 | 仅 `reasoning.summary` 摘要（文档：只返回供应商允许公开的摘要，不返回原始私有思维链） | 展示降级 |
| 输出预算 | `max_tokens` 只管可见输出 | `max_output_tokens` **含推理 token** | 语义变化 |
| 采样默认 | `temperature` 默认 1 | `temperature` **默认 0.6** | 行为变化 |
| 工具调用 | `role:tool` + `tool_call_id` | `function_call` + `function_call_output` + `call_id` | 等价 |
| 多轮状态 | 本地全历史 | `previous_response_id` 固定 null，同样本地全历史 | 等价 |
| 结构化输出 | `response_format` | `text.format`（json_schema 仅 2 个模型支持） | 收窄 |

**结论：Responses 作为「无摩擦默认」不成立；作为「有回退保障的默认」成立。** 方案核心就是这条保障（§五）。

---

## 三、完整字段能力矩阵（逐条核对原表）

### 3.1 Chat Completions — 五个对话模型的请求字段

✅=文档明确支持且生效　⚠️=支持但有条件/被忽略　❌=文档未列

| 字段 | 6.8-flash-lite | deepseek-v4-flash | deepseek-flash (V4.1) | glm-5.2 | kimi-k3 |
|---|---|---|---|---|---|
| `model` | ✅ 固定值 | ✅ 固定值 | ✅ | ✅ 固定值 | ✅ 固定值 |
| `messages` | ✅ role: system/user/assistant/tool | ✅ | ✅ | ✅ | ✅ |
| `stream` | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`stream_options.include_usage`** | ✅ **默认 true** | ✅ **默认 true** | ✅ **默认 true** | ❌ **参数表无此字段** | ✅ **默认 true** |
| `temperature` | ✅ [0,2] 默认 1 | ✅ [0,2) 默认 1 | ✅ [0,2] 默认 1 | ✅ [0,2) 默认 1 | ⚠️ **固定 1，传了也不变** |
| `top_p` | ✅ (0,1] 默认 1 | ✅ 思考时最小 0.95，非思考固定 1.0 | ✅ 同 v4-flash | ✅ (0,1] **默认 0.95** | ⚠️ **固定 0.95** |
| **输出上限字段名** | `max_tokens` ≤65536 | `max_tokens` ≤384000 | `max_tokens` ≤393216 | `max_tokens` ≤128K | ⚠️ **`max_completion_tokens`（不是 `max_tokens`）** ≤1M−prompt |
| 输出上限默认值 | 65535 | 非思考 8K / 思考 64K / `max` 时 128K | 131072 | 64K | 128K |
| `n` | ✅ 1–7 | ❌ | ⚠️ 仅 1 生效（1–5） | ❌ | ❌ |
| `stop` | ✅ string\|array | ✅ object | ✅ string\|array，**最多 16 个** | ✅ string\|array | ✅ string\|array |
| `frequency_penalty` | ✅ [0,2] | ⚠️ 思考模式不生效（不报错） | ⚠️ 同左，且仅 Chat 接口 | ❌ | ⚠️ **固定 0，建议不传** |
| `presence_penalty` | ✅ [0,2] | ⚠️ 同上 | ⚠️ 同上 | ❌ | ⚠️ 固定 0 |
| `thinking` | ✅ string `enabled`/`disabled` | ✅ string 同 | ⚠️ **object\|string**，OpenAI 兼容下 `{type:enabled/disabled}`，**不支持 `adaptive`** | ❌ **传 `disabled` 直接失败** | ✅ string 同 |
| `reasoning_effort` | ✅ 默认 `high`；`low`/`medium`/`high`/`max`/`none` | ✅ 默认 `high`；同上 | ✅ 默认 `high`；原生 `none`/`low`/`high`/`max` + 兼容映射 | ✅ **默认 `max`**；`max`/`xhigh`/`high`/`medium`/`low`/`minimal`/`none` | ✅ **默认 `max`**；`low`/`medium`/`high`/`max`（参数表无 `none`） |
| `tools` | ✅ | ✅ 仅 function | ✅ 仅 function | ✅ | ✅ |
| `tool_choice` | ✅ | ✅ | ✅ 思考模式支持 `required` | ⚠️ **仅 string** | ✅ string\|object |
| `parallel_tool_calls` | ✅ 默认 true | ❌ | ❌ | ❌ | ✅ 默认 true |
| `seed` | ✅ Beta [0,9999999) | ❌ | ❌ | ❌ | ✅ Beta [0,9999999) |
| `response_format` | ❌（正文提及 json_object 限制） | ✅ `json_object` | ✅ `text`/`json_object`/`json_schema` | ✅ `text`/`json_object` | ✅ `json_object` |
| `logprobs`/`top_logprobs` | ❌ | ❌ | ✅ [0,20] | ❌ | ❌ |
| `do_sample` | ❌ | ❌ | ❌ | ✅ **独有**，默认 true；false 时忽略 temperature/top_p | ❌ |
| 图像输入 | ✅ `image_url.url`（公网 URL 或 base64）；jpg/jpeg/png/webp | ❌ 无图像章节 | ✅ JPEG/PNG/GIF/WebP；单图 ≤50MB、总请求体 ≤64MB、≤200 张、URL 总量 ≤200MB | ❌ 无图像章节 | ✅ JPEG/PNG/WebP/GIF/BMP/HEIC/HEIF；**不支持公网 URL，仅 base64**，content 必须对象数组 |
| 视频输入 | ❌ | ❌ | ✅ **仅 Chat Completions** | ❌ | ❌ |

**多轮 `reasoning_content` 回传规则（各家不同，最易踩坑）：**

| 模型 | 带 `tools` 时 | 不带 `tools` 时 |
|---|---|---|
| 6.8-flash-lite / glm-5.2 / kimi-k3 | — | 「只将 `content` 回传，不回传 `reasoning_content`，减少 token 消耗」 |
| deepseek-v4-flash / deepseek-flash | 「**需回传所有历史轮次的 `reasoning_content`**，将被拼接至上下文，以保证工具调用链路的完整性」 | 「无需回传，即使传入也会被忽略且不会拼接」 |
| kimi-k3 | 「**多轮对话 & 工具调用：必须原样回传完整 assistant message**」 | 同左 |

> **deepseek 系列带 `tools` 时必须重放历史思维链，而 6.8/glm/kimi 恰好相反** —— 插件必须按模型分派，不能一刀切。

**思考模式通用限制：**「思考模式与 JSON 模式不建议同时开启」；「思考模式响应时间较长，建议 `stream=true`」（6.8 / glm / kimi 三节均有）。

### 3.2 Responses — 请求字段（文档仅一张统一表，无 per-model 差异说明）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `model` | string | — | 必填 |
| `input` | string\|array | — | 必填；字符串等价一条 user 文本；数组按时间线携带完整历史，**可含 `{role:"system",content}` 项** |
| `instructions` | string\|null | null | 系统指令，优先级最高 |
| `stream` | boolean | false | |
| `max_output_tokens` | integer\|null | 模型默认 | **含可见输出及推理 token**，须 >0；超限 → `status=incomplete` |
| `temperature` | number\|null | **0.6**（Chat 是 1） | 6.8/v4.1-flash [0,2]；v4-flash/glm [0,2) |
| `top_p` | number\|null | 同 chat | (0,1] |
| `tools` | array | [] | **仅 `type=function`，扁平结构无 `function` 嵌套层** |
| `tool_choice` | string\|object | `auto` | `auto`/`none`/`required` 或 `{type:function,name}` |
| `parallel_tool_calls` | boolean | true | 模型不支持时传 true **静默忽略** |
| `text` | object | `{"format":{"type":"text"}}` | 结构化输出 |
| `reasoning` | object\|null | 模型默认 | `.effort`（**非 none 无效**）+ `.summary`（`auto`/`concise`/`detailed`） |
| `store` / `background` | — | — | **仅显式传 `true` 报错**；不传或 `false` 正常 |
| `previous_response_id` | — | — | 本期固定 null |
| `truncation` / `include` | — | — | **参数表未出现** |

- **支持模型 5 个**：`sensenova-6.8-flash-lite`、`deepseek-v4-flash`、`deepseek-flash`、`glm-5.2`、`kimi-k3`（不含 `sensenova-u1.5-*`）。
- **`max_output_tokens` 范围**：6.8-flash-lite [1,65536]｜deepseek-v4-flash [1,384000]｜glm-5.2 [1,131072]｜kimi-k3 [1,1048576] —— **`deepseek-flash` 未列**（却在支持模型表内，须实测）。
- **`text.format.type`**：`deepseek-flash`、`kimi-k3` 支持 `text`/`json_object`/`json_schema`；`6.8-flash-lite`、`deepseek-v4-flash`、`glm-5.2` 仅 `text`/`json_object`。
- **Responses 默认 effort**：6.8 / v4-flash / v4.1-flash → `high`；glm-5.2 / kimi-k3 → `max`。

**SSE 事件序列（原表顺序）：**
`response.created` → `in_progress` →
[reasoning: `output_item.added` → `reasoning_summary_part.added` → `reasoning_summary_text.delta`×N → `.done` → `reasoning_summary_part.done` → `output_item.done`] →
[message: `output_item.added` → `content_part.added` → `output_text.delta`×N → `output_text.done` → `content_part.done` → `output_item.done`] →
[function_call×N: `output_item.added` → `function_call_arguments.delta`×N → `.done` → `output_item.done`] →
**`response.completed` / `response.incomplete` / `response.failed`**

**流以终态事件结束，没有 `data: [DONE]`。** 每条事件带 `event` 类型 + 递增 `sequence_number`；字段含 `item_id`、`output_index`、`content_index`、`delta`。并行工具调用时各 `function_call` 用独立 `output_index`/`item_id`/`call_id`，delta 交错到达须**分别拼接**。

**`output` 条目类型：**
- `reasoning`：`id: rs_*`、`summary: [{type:"summary_text", text}]`（只有摘要）
- `message`：`id: msg_*`、`content: [{type:"output_text", text, annotations} | {type:"refusal"}]`
- `function_call`：`id: fc_*`、`call_id`、`name`、`arguments` 为 JSON 字符串

**usage：** `input_tokens` / `output_tokens`（含推理）/ `total_tokens` / `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens`

**Responses 不支持（原表）：** 响应存储、`previous_response_id` 续写、Conversations、后台任务、Webhook、上下文压缩、响应查询/删除/取消、Input Items 查询、内置工具（Web Search / File Search / Code Interpreter / MCP）、视频、`input_file`。

**图像输入：** `{"type":"input_image","image_url": <公网 URL 或 data:image/*;base64,...>}` 配 `{"type":"input_text","text":...}`；支持 png/jpeg/gif/webp；不支持 Files API 的 `file_id`。

### 3.3 目录接口 `/v1/models`

现有 `parseCatalog()`（`src/adapter.ts:277`）读取的 `context_length`、`max_output_length`、`input_modalities`、`output_modalities`、`supported_features` **与官方字段完全一致，无需改动**。

示例对象（6.8-flash-lite）另含：`hugging_face_id`、`quantization`、`pricing`、`supported_sampling_parameters`、`openrouter.slug`、`datacenters[].country_code`、`created`、`description`。

- 目录**不返回 effort 词表**（无 `reasoning_efforts`/`reasoning_levels`）→ 插件静态表是档位唯一真相源，而它当前几乎全错（§四·P0-1）。
- 目录**可提供** `supported_sampling_parameters`（6.8-flash-lite 返回 `["temperature","stop"]`）—— 这是插件**按模型裁剪请求字段的天然依据**：可避免给 glm-5.2 发 `thinking`（会失败）、给 kimi-k3 发 `frequency_penalty`（文档建议不传）。

---

## 四、既有代码缺陷清单

| # | 缺陷 | 位置 | 严重度 |
|---|---|---|---|
| **P0-1** | **推理档位表几乎全错**。按 §3.1 权威列：`6.8-flash-lite` 缺 `max`；`deepseek-v4-flash` 缺 `max`；`glm-5.2` 缺 `max`/`xhigh`/`minimal`（实际默认 `max`，插件却标默认 `high`）；`kimi-k3` 缺 `medium`（实际默认 `max`）；**`deepseek-flash` 整条缺失**；`deepseek-v4-pro` 已不在文档阵容却仍有条目 | `src/adapter.ts:78-84` | 极高——用户选 `high` 给 glm-5.2 实际按 `max` 跑，持续多计费 |
| **P0-2** | **多模态输入静默丢弃**。`flattenText()`/`toolResultText()` 只取 text 块。6.8-flash-lite / deepseek-flash / kimi-k3 全是多模态模型 → 粘图无报错、无图、答非所问 | `src/adapter.ts:166-175` | 极高 |
| **P0-3** | **kimi-k3 输出上限字段名错**。文档用 `max_completion_tokens`，`buildOpenAiBody` 无条件发 `max_tokens` | `src/adapter.ts:379` | 高（是否硬报错待实测） |
| **P0-4** | **`stream_options` 从未发送**。文档对 6.8/v4-flash/v4.1-flash/kimi-k3 均标 `include_usage` **默认 true**，但 glm-5.2 **参数表无此字段**，其流式 usage 行为未知。不显式发送属于依赖服务端默认值，风险不可控 | `src/adapter.ts:369-384` | 中 |
| **P0-5** | **多轮思维链回传未按模型分派**。deepseek 系列带 `tools` 时必须重放历史 `reasoning_content`，当前 `toOpenAiMessages()` 只发 `content` + `tool_calls` | `src/adapter.ts:309-366` | 中（工具链路可能不完整） |
| **P0-6** | **未按模型裁剪不支持字段**。给 glm-5.2 发 `thinking.type=disabled` 会**直接失败**；给 kimi-k3 发 `frequency_penalty` 文档建议不传；给 v4-flash/glm 发 `n`/`seed`/`parallel_tool_calls` 文档未列 | `src/adapter.ts:369-384` | 中 |
| **P1-1** | `reasoningInfoFrom()` 用静态表补全档位时不设 `defaultEffort`，用户看不到「当前默认档」 | `src/adapter.ts` ~:211-254 | 低 |
| **P1-2** | 主 spec 残留已废弃内容：「Requirement: 手动模型可选覆盖」整节仍在，两个设置页 Scenario 仍写「手动模型筛选」「手动加入模型、隐藏模型」——与已完成的 `remove-sensenova-model-selection-uis`（✓ Complete，未 archive）矛盾 | `openspec/specs/sensenova-provider/spec.md:366-393`、`:247`、`:267` | 中 |

宿主 `@deepseek-ai/dsh-llm@0.1.2-rc.1` 已 re-export `@deepseek-ai/dsh-attachment` 的 `contentHasImage` / `projectImagesForTextModel` / `offloadRequestImagesWithPolicy` —— **多模态是宿主一等公民能力，插件落后于宿主，应复用而非自造**。

---

## 五、核心设计：按请求决定 wire

### 5.1 三种模式（配置 `wireProtocol`）

| 值 | 语义 |
|---|---|
| `auto`（**默认**） | 优先 Responses。仅当该请求会因 Responses 丢失语义时自动改用 Chat Completions。用户无需知情，也不丢语义 |
| `responses` | 强制 Responses，不回退。遇到无法保真的请求直接报错并说明切换方法 |
| `chat-completions` | 完全保持今天的行为（零回归通道 + 故障逃生舱） |

### 5.2 决策函数

```
resolveWirePlan(options, config, modelFacts) → { wire, reason }
```

任一命中即降级 Chat：

| # | 条件 | 原因 |
|---|---|---|
| 1 | `options.stop` 非空 | Responses 无 `stop` 字段 |
| 2 | 模型不在 Responses 支持集（6.8-flash-lite / deepseek-v4-flash / deepseek-flash / glm-5.2 / kimi-k3） | 端点不支持该模型 |
| 3 | `options.reasoningEffort` 既非 `none`、又非该模型的 Responses 默认档 | 传了也无效 → 只有 Chat 能兑现用户显式选择 |
| 4 | 该模型已被运行时标记为 Responses 不可用（§5.3） | 文档与实况不符 |

**第 3 条是设计的关键**，把「档位失效」从静默降级变成显式保真：

| 用户选 | Responses 默认 | 判定 | 实际行为 |
|---|---|---|---|
| `none` | 任意 | Responses，**显式发** `reasoning:{effort:"none"}` | 真关闭 ✅ |
| `high`（glm-5.2，默认 `max`） | `max` | **降级 Chat** | 真按 `high` 跑 ✅ |
| `max`（glm-5.2） | `max` | Responses，**不发 `reasoning`** | 默认本就是 max，省略即等价 ✅ |
| `high`（6.8-flash-lite，默认 `high`） | `high` | Responses，**不发 `reasoning`** | ✅ |
| 未选档位 | 任意 | Responses，**不发 `reasoning`** | 用模型默认 ✅ |

即「**省略优于传无效值**」：非 `none` 的 `reasoning.effort` 在 Responses 上是空操作，就不要发；只有用户选择**偏离**默认、或要**关闭**思考时，才需要 Chat 或显式 `none`。

### 5.3 运行时不符兜底

文档有 3 处自相矛盾（§八），不能只信文档。维护进程内 `responsesUnsupported: Set<string>`：

- Responses 对某模型返回 HTTP 400 且 `error.type === 'invalid_request_error'` → 记入集合，**本次立即改用 Chat 重试一次**，后续该模型直接走 Chat。
- 记入时打一条日志说明原因，避免用户困惑。
- 不持久化、不写入配置。

这让「默认 Responses」的上线风险可控：文档错了只退化成「该模型走 Chat」，不退化成「该模型不可用」。

### 5.4 协议纪律（照官方 Codex 配置的样子做）

官方 Codex 配置为此专门设 `disable_response_storage = true` 来规避 `previous_response_id` 的 400（文档 `#tools-codex`，要求 Codex ≥ 0.156.1；新版 Codex 仅支持 responses 协议）。插件照做：

- 绝不发送 `store` / `background` / `previous_response_id` / `truncation` / `include`。
- **不等待也不识别 `data: [DONE]`**。
- 多轮历史全部由本地 `input` 数组携带。
- `tools` 只用 `type=function`（SenseNova 内置工具全不支持，插件本来就不用，无冲突）。
- 图像用 `{"type":"input_image","image_url": <URL 或 data URL>}` + `{"type":"input_text","text":...}`，仅 png/jpeg/gif/webp。

---

## 六、实现形态

### 6.1 分派点

宿主 `abstract class LlmAdapter` 只有 `providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` / `resolveModel` / `prepareCall` / `abstract stream(options)`，**没有任何 wire 协议抽象** —— 协议完全由插件的 `stream()` 实现。故在同一方法内分派：

```
stream(options)                                       src/adapter.ts:958
 ├─ modelFacts = factsFor(options.model, catalog)      新增：模型能力档案
 ├─ resolveWirePlan(options, config, modelFacts) ──► wire
 ├─ buildBody(wire, options, modelFacts)               新增（取代 :960 直调）
 ├─ 取连接 / 取 key / 取并发额度                       现有不动
 ├─ fetch(`${apiBase}/${pathFor(wire)}`)               :1016 路径参数化
 │    └─ 400 invalid_request_error + wire=responses    新增：记集合 + 换 Chat 重试
 ├─ 轮换 / 429 分类 / 分级退避 / 超时看门狗             现有不动
 └─ 解析流：chat ? parseOpenAiSse() : parseResponsesSse()
```

**关键约束：wire 一旦选定，整次请求（含所有轮换重试）不再切换。** 否则同一轮对话会出现「前半段 Responses、后半段 Chat」的混合历史，`function_call` 与 `role:tool` 的 id 体系会串。§5.3 的兜底是唯一例外，且发生在任何内容流出之前。

### 6.2 模型能力档案（新增核心抽象）

```
src/wire/facts.ts
  interface ModelFacts {
    id: string
    supportedWires: ('chat-completions'|'responses')[]
    efforts: readonly string[]        // 按 §3.1 权威列
    defaultEffort: string
    responsesDefaultEffort: string    // §5.2 判定用
    outputLimitField: 'max_tokens'|'max_completion_tokens'
    outputLimitMax: number
    supportsImages: boolean
    imageFormats: readonly string[]
    imageRequiresBase64: boolean      // kimi-k3
    requiresReasoningReplay: boolean  // deepseek 系列带 tools 时
    forbidThinkingDisabled: boolean   // glm-5.2
    fixedTemperature: number|null     // kimi-k3 = 1
    fixedTopP: number|null            // kimi-k3 = 0.95
    supportsStreamOptions: boolean    // glm-5.2 = false
    responsesMaxOutputTokens: number|null
    responsesSupportsJsonSchema: boolean
  }
```

优先级：**目录实测值 > 静态档案**。`/v1/models` 的 `context_length` / `max_output_length` / `input_modalities` / `supported_sampling_parameters` 是实测真值；静态档案只补文档明确、目录未返回的字段（effort 词表、各家 quirky 限制）。

### 6.3 文件划分

```
src/wire/types.ts              WireProtocol / WirePlan / WireReason / ModelFacts
src/wire/facts.ts              各模型静态档案 + 目录合并 + 请求字段裁剪
src/wire/plan.ts               resolveWirePlan()（§5.2 判定表）
src/wire/body-chat.ts          现 buildOpenAiBody 迁出 + P0-3/4/6 修正
src/wire/body-responses.ts     toResponsesInput() / instructions / tools / reasoning
src/wire/sse-responses.ts      Responses 事件流 → StreamChunk[]
src/wire/usage.ts              两种 usage 字段名 → TokenUsage
src/wire/blocks.ts             内容块 → wire 块（文本 + 图像，chat/responses 双分支）
```

### 6.4 Chat 请求体字段分派（修 P0-3/4/6）

按 `ModelFacts` 决定发什么：

| 字段 | 分派规则 |
|---|---|
| `max_tokens` / `max_completion_tokens` | kimi-k3 用后者，其余用前者；按 `outputLimitMax` 钳制 |
| `stream_options` | `supportsStreamOptions` 为真时显式发 `{include_usage:true}`；**glm-5.2 不发** |
| `temperature` | `fixedTemperature !== null`（kimi-k3）时不发；deepseek 系列思考模式下不发（文档：思考模式不生效，传了不报错但无意义） |
| `top_p` | `fixedTopP !== null`（kimi-k3）时不发 |
| `thinking` | `forbidThinkingDisabled`（glm-5.2）时**绝不发送任何 `thinking` 字段** |
| `frequency_penalty` / `presence_penalty` | 仅 6.8-flash-lite 发（其余模型不支持或不建议） |
| `n` / `seed` / `parallel_tool_calls` | 仅目录 `supported_sampling_parameters` 列出的模型发 |
| `reasoning_effort` | 按 `efforts` 白名单过滤；`none` 恒允许 |
| 历史 `reasoning_content` | `requiresReasoningReplay && tools.length>0` 时回放全部历史思维链 |

### 6.5 Responses 请求体映射

| `GenerateOptions` | Responses 字段 | 处理 |
|---|---|---|
| `model` | `model` | 直传 |
| `system` | `instructions` | 优先级最高，独立字段 |
| `messages` | `input[]` | 见下 |
| `tools` | `tools[]` | **扁平** `{type:'function',name,description,parameters,strict}` |
| `maxTokens` | `max_output_tokens` | 按 `responsesMaxOutputTokens` 钳制；**含推理 token，需 UI 提示** |
| `temperature` | `temperature` | 仅用户显式设置时发；未设用模型默认（**Responses 默认 0.6**，Chat 是 1 —— 切换后是行为变化） |
| `reasoningEffort` | `reasoning.effort` | **仅 `none` 时发**（§5.2） |
| — | `reasoning.summary` | 新配置，默认 `auto`，可选 `concise`/`detailed` |
| `stop` | — | 不发；命中即降级 Chat |
| — | `stream` | 恒 `true` |

`input[]` 映射（对比现有 `toOpenAiMessages()` `src/adapter.ts:309-366`）：

| 宿主 `Message` | Responses `input` 项 |
|---|---|
| system | 抽到 `instructions`（文档两种形式都出现；`instructions` 更规范且优先级最高） |
| user 文本 | `{role:'user',content:[{type:'input_text',text}]}` |
| user 图像 | `{role:'user',content:[{type:'input_image',image_url}]}` |
| assistant 文本 | `{role:'assistant',content:[{type:'output_text',text}]}` |
| assistant tool-call | `{type:'function_call',call_id,name,arguments}` |
| tool-result | `{type:'function_call_output',call_id,output}` |

**工具 id 体系**：以 Responses 的 **`call_id`**（不是 item `id` / `fc_*`）作为宿主 `ToolCallId` 发出，回传时原样作 `function_call_output.call_id`，跨轮稳定。

现有 Chat 路径的三条防御逻辑（`src/adapter.ts:319-344`：空 `name` 的 tool_call 丢弃、`arguments` 空串补 `{}`、`id` 空串合成 `sensenova-sanitized-N`、孤立 tool-result 丢弃）**必须同样套用到 Responses 路径**，否则重放坏历史会 400。

### 6.6 Responses SSE → `StreamChunk`

Responses 的 `output_index`（reasoning / message / function_call 按产生顺序）**可直接复用为宿主 block index**，因为 `output[]` 的语义顺序与宿主的「思考块 / 文本块 / 工具调用块」顺序一致。

| Responses 事件 | `StreamChunk` |
|---|---|
| `response.output_item.added` | `block-start{index, blockType}` |
| `response.reasoning_summary_text.delta` | `reasoning-delta{index: output_index, text: delta}` |
| `response.output_text.delta` | `text-delta{index, text: delta}` |
| `response.function_call_arguments.delta` | `tool-call-delta{index, id: call_id, name?, argumentsDelta: delta}` |
| `response.output_item.done` | `block-end{index, block}` |
| `response.completed` | `finish{stop｜tool-calls}` |
| `response.incomplete` + `incomplete_details.reason=max_output_tokens` | `finish{max-tokens}` |
| `response.incomplete` + `reason=content_filter` | `finish{error}` |
| `response.failed` | `finish{error}`（带 `error`） |
| `response.completed.response.usage` | `usage` |

并行工具调用：各 `function_call` 有独立 `output_index`/`item_id`/`call_id`，delta 交错，**必须按 `item_id`（或 `output_index`）分别维护拼接缓冲区**。

`finish` 的 `tool-calls` 判定：扫 `response.completed.response.output[]` 是否含 `type === 'function_call'`。

### 6.7 usage 映射

Responses 字段名不同但语义一致，复用现有 `mapUsage()`（`src/adapter.ts:387-401`）核心逻辑：

```
input_tokens / output_tokens / total_tokens
input_tokens_details.cached_tokens     → cacheReadTokens
output_tokens_details.reasoning_tokens → reasoningTokens
```

注意宿主 `TokenUsage.inputTokens` 语义是**未缓存输入**（`prompt − cached`，见 `src/adapter.ts:396`）。Responses 的 `input_tokens` 是否已含缓存**文档未明说，须实测**（§八·11）——若已含则不能重复扣。

---

## 七、版本切分

| 版本 | 主题 | 内容 | 风险 |
|---|---|---|---|
| `0.2.0-alpha.1` | 字段对齐 | P0-1 档位矩阵；P0-3 kimi-k3 字段名；P0-4 `stream_options`；P0-5 思维链回传分派；P0-6 按目录裁剪字段；P1-1 `defaultEffort`；P1-2 spec 残留清理 | 低 |
| `0.2.0-alpha.2` | **Responses 默认** | `facts/plan/body-responses/sse-responses/usage`；`wireProtocol` 配置 + UI；三模式与回退决策；§5.3 运行时兜底；Chat 分支迁到 `body-chat.ts` | 中 |
| `0.2.0-alpha.3` | 多模态 | `blocks.ts`；image 块支持（chat/responses 双分支）；复用宿主 attachment 能力；kimi-k3 公网 URL 限制处理 | 低 |

排序理由：alpha.1 是**纯 bug 修正**（档位错误正在让用户多付钱），不依赖任何新抽象，风险最低、收益最直接，先落地。Responses 需要 `facts.ts` 的档案能力，天然依赖 alpha.1。多模态虽然严重（静默丢图），但需要新的内容块抽象，放最后单独验证。

发布走**插件市场**（dshmarket 卡片「更新」按钮）；GitHub 型插件的 pinned codeload URL 由市场自动重写到新 commit，不手工改动。

---

## 八、文档矛盾与待实测清单

**文档自相矛盾（不得当作既定事实写进 spec）：**
1. **kimi-k3 的 `reasoning_effort`**：参数表只列 `low`/`medium`/`high`/`max`（无 `none`），但同节「思考强度」表列了 `none` → 关闭推理。且 `thinking:"disabled"` 也在参数表里。到底哪个为准未明说。
2. **glm-5.2 的字段名**：响应结构用 `reasoning_content`，但其工具回传示例里 assistant 消息用的是 `reasoning`。
3. **`deepseek-v4-pro` 已不在文档模型阵容中**，插件 `KNOWN_EFFORTS` 仍有其条目。

**文档未明确：**
4. `truncation` / `include` 未出现在 Responses 请求参数表；`store` / `background` 只说「显式传 `true` 时报错」，未给错误码。
5. Responses 的 `max_output_tokens` 范围表**漏了 `deepseek-flash`**（虽在支持模型列表内）。
6. **glm-5.2 参数表无 `stream_options`** —— 其流式 usage 是否返回未知。
7. Anthropic Messages API 无独立支持模型列表（图片块注明仅 6.8-flash-lite 支持）。**本期不做 Messages 协议。**

**需真实 Key 实测（凭据禁区：全程由用户本人执行）：**
8. **§5.2 决策表的地基** —— Responses 下 `reasoning.effort` 传非 `none` 值是否真的无效。用 `output_tokens_details.reasoning_tokens` 对比 `none` / `high` 两次调用即可证实。若实际生效，决策规则要重写。
9. kimi-k3 用 `max_tokens` 而非 `max_completion_tokens` 是硬报错还是静默忽略（决定 P0-3 优先级）。
10. glm-5.2 流式响应是否带 `usage`（决定 P0-4 是否需要给它单独处理）。
11. Responses 的 `input_tokens` 是否已含 `input_tokens_details.cached_tokens`。
12. Responses 下历史 assistant 消息是否需要携带 reasoning 项回放（Chat 下 deepseek/kimi 明确要求，Responses 未说明）。
13. `reasoning.summary` 三档的实际摘要长度与形态。
14. Responses SSE 的 `sequence_number` 是否严格递增；并行工具调用下 `output_index` 与 item 对应是否稳定。
15. 各模型真实 `context_length` / `max_output_length` / `supported_sampling_parameters`（文档只给了 6.8-flash-lite 一个示例）。

---

## 九、OpenSpec 变更提案

按 `openspec/config.yaml`（`schema: spec-driven`、语言 `zh_cn`；产物用中文，结构标题与 SHALL/MUST 保留英文）：

1. **`align-request-fields-with-docs`** — 按 §3.1 权威矩阵修正 effort 表；新增 `deepseek-flash`、移除 `deepseek-v4-pro`；kimi-k3 `max_completion_tokens`；显式 `stream_options`（glm-5.2 除外）；按模型回放历史 `reasoning_content`；按 `supported_sampling_parameters` 裁剪字段；glm-5.2 禁发 `thinking`；补 `defaultEffort`；清理 spec 废弃内容。
2. **`add-model-facts`** — `ModelFacts` 抽象：目录实测值优先、静态档案补文档专有字段；供 §3 的请求裁剪与 §5.2 的 wire 决策共用。
3. **`make-responses-default-wire-protocol`** — `wireProtocol` 三模式；`resolveWirePlan` 判定；Responses 请求体与 SSE 翻译；协议纪律（不发 store/background/previous_response_id/truncation/include、不发 stop、不等 `[DONE]`）；档位保真回退；运行时 400 兜底；UI 与能力损失提示。
4. **`add-multimodal-input`** — 内容块翻译抽象；image 块支持；宿主 attachment 能力复用；按模型能力降级（kimi-k3 base64-only）。
5. 归档 `remove-sensenova-model-selection-uis`（须先完成第 1 项的 spec 残留清理）。

依赖：1 → 2 → 3；4 依赖 2 的 `blocks.ts`，可与 3 并行。

---

## 十、建议执行顺序

1. **先做 §八·8 的实测**（两次真实调用）—— 它验证 §5.2 决策表的地基。若实际与文档不符，wire 决策规则要重写，越早发现越省事。
2. 建 `align-request-fields-with-docs` + `add-model-facts`，止住档位错误计费与 kimi-k3 字段名问题。
3. 建 `make-responses-default-wire-protocol`，带 §5.3 运行时兜底上线。
4. 建 `add-multimodal-input`。
5. 永久保留 `wireProtocol: 'chat-completions'` 逃生舱，不设移除时间表。