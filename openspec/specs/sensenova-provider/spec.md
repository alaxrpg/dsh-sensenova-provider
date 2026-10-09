# sensenova-provider Specification

## Purpose
为 DeepSeek Harness 提供 SenseNova（OpenAI 兼容）LLM provider 接入：注册独立 `sensenova` 路由，支持在同一 baseURL 下配置多个 API Key 账号，在密钥失效（401）时自动轮换，429 限流交由宿主重试层退避后原 key 重试。

## Requirements

### Requirement: 注册 sensenova provider 路由

系统 SHALL 向宿主 llm 服务注册名为 `sensenova` 的 provider 路由，并声明为可配置 provider，显示名为 SenseNova。

#### Scenario: 路由注册成功

- **WHEN** 插件在宿主中加载
- **THEN** 宿主模型选择器中出现 `sensenova` provider 分组，且不与既有 `sensennova` 路由冲突

### Requirement: 多账号配置

系统 SHALL 支持在同一 `apiBase` 下配置一个默认账号与零到多个额外账号，每个账号包含标签与凭据引用（`apiKeyEnv`，POSIX shell 标识符形式的 credential-ref）。

#### Scenario: 仅默认账号

- **WHEN** 用户仅配置 `apiKeyEnv`（默认 `SENSENOVA_API_KEY`）而未配置 `accounts`
- **THEN** 系统使用该默认账号的 key 服务所有请求

#### Scenario: 额外账号参与轮换

- **WHEN** 用户配置了 `accounts` 列表
- **THEN** 每个具备合法 `apiKeyEnv` credential-ref 的条目都成为一个可轮换账号，无合法凭据引用的条目被忽略

#### Scenario: 手动钉选账号

- **WHEN** 用户设置 `activeAccount` 指向某个账号 id
- **THEN** 该账号在可用时优先服务请求，不可用时回退到第一个可用账号

### Requirement: 429 不冷却不轮换

系统 SHALL 在收到 429 响应时解析错误体 `error.code`，区分「配额类 429」与「非配额类 429」：配额类包括速率配额耗尽（`code` 为 `8`，message 形如 `rps exhausted`/`rpm exhausted`）与推理 TPM 耗尽（`code` 为 `429001`，message 形如 `inference tpm exhausted`）。所有 429 仍 SHALL 不做账号级冷却、不禁用账号。

默认（`quotaRotation` 关闭）时，429 SHALL NOT 切换到其他账号，一个会话固定使用一个 key。系统 SHALL 提供「配额类 429 换 key」设置开关（默认关闭，收纳于高级设置折叠区）：开启后，仅配额类 429 SHALL 触发切换到下一把可用 key 并粘住新 key（同一会话后续请求继续使用新 key），环回一圈仍被配额类 429 拒绝时 SHALL 停留在当前 key 按退避下限等待；非配额类 429 在任何设置下 SHALL NOT 触发轮换。

对配额类 429，系统 SHALL 以 `RATE_LIMIT` 错误结束本次请求，并 SHALL 携带 `providerRetryAfterMs` 作为退避指导：速率类（code 8）为固定下限 15000 毫秒；TPM 类（code 429001）采用分级探测退避，档位 SHALL 随该会话连续命中次数递增为 3000 → 5000 → 10000 → 15000 毫秒后封顶，任一请求成功或切换到新 key 后 SHALL 归零重新从 3000 毫秒开始（2026-09-04 实测：429001 为 per-key 推理 token 限速，恢复时间不定，固定长下限会把会话干锁在死等；短档位递增探测 + 优先换 key 才能在恢复第一时间接上）。当响应携带 `Retry-After` 且换算毫秒值大于当前档位时，SHALL 采用 `Retry-After` 值，且采用值整体 SHALL NOT 超过 60000 毫秒（超出时按 60000 毫秒采用；60000 毫秒与「Provider 重试策略」声明的单次延迟上限一致，保证宿主重试层不会因采用值超过单次延迟上限而放弃重试）。对非配额类 429（无 `error.code` 或其他 code），系统 SHALL 维持既有行为：`Retry-After` 在大于 0 且不超过重试策略单次延迟上限（见「Provider 重试策略」）时透传，否则不透传也不截断，由宿主本地退避策略计算。

#### Scenario: 429 不轮换不冷却

- **WHEN** 某账号请求收到 429 且存在其他可用账号，「配额类 429 换 key」开关处于关闭状态
- **THEN** 系统不标记冷却、不切换账号，以 `RATE_LIMIT` 错误结束本次请求由宿主重试层退避后用原 key 重试

#### Scenario: 开启轮换后配额类 429 粘性换 key

- **WHEN** 「配额类 429 换 key」开关开启，某会话的请求收到配额类 429（code 8 或 429001）且存在未在本次请求中试过的其他可用账号
- **THEN** 系统切换到下一把可用 key 重试本次请求，且该会话后续请求继续使用新 key，直至新 key 也收到配额类 429 再依序切换

#### Scenario: 轮换环回后停止切换

- **WHEN** 开关开启且本轮请求已按序试过所有可用账号均被配额类 429 拒绝
- **THEN** 系统停留在当前 key，按退避下限等待后重试，不再重复切换，也不禁用任何账号

#### Scenario: 速率配额耗尽给出分钟级退避下限

- **WHEN** 某账号请求收到 429 且错误体为 `{"error":{"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}}`（响应无 `Retry-After` 头）
- **THEN** 系统不标记冷却、不切换账号，以 `RATE_LIMIT` 错误结束本次请求，且错误携带 `providerRetryAfterMs` 不低于 15000 毫秒

#### Scenario: TPM 耗尽给出分级探测退避

- **WHEN** 某账号请求收到 429 且错误体包含 `error.code` 为 `429001`（inference tpm exhausted），且该会话此前已连续命中 n 次
- **THEN** 系统以 `RATE_LIMIT` 错误结束本次请求且不轮换账号，错误携带 `providerRetryAfterMs` 为分级档位第 min(n+1, 4) 档（3000/5000/10000/15000 毫秒）

#### Scenario: TPM 分级档位成功后归零

- **WHEN** 某会话经历 429001 分级退避后任一请求成功
- **THEN** 该会话的连续命中计数归零，下一次 429001 退避从 3000 毫秒重新开始

#### Scenario: 配额类 Retry-After 采用值不突破单次延迟上限

- **WHEN** 配额类 429 响应携带 `Retry-After: 120`（换算 120000 毫秒，大于当前档位）
- **THEN** 系统按 60000 毫秒采用作为 `providerRetryAfterMs`（不超过重试策略单次延迟上限），宿主重试层继续按该指导延迟重试而不是放弃重试

#### Scenario: 短 Retry-After 透传

- **WHEN** 非配额类 429 响应携带 `Retry-After` 且换算毫秒值大于 0 且不超过重试策略单次延迟上限
- **THEN** 系统将该值作为 `providerRetryAfterMs` 透传给宿主重试层

#### Scenario: 超长 Retry-After 不突破上限

- **WHEN** 非配额类 429 响应的 `Retry-After` 超过重试策略单次延迟上限
- **THEN** 系统不透传该值（不截断），由宿主本地退避策略计算延迟

#### Scenario: 配额类 429 不因多会话共享而互踢

- **WHEN** 两个会话使用同一 key 且先后收到配额类 429，轮换开关关闭
- **THEN** 两个会话各自按退避下限等待后用原 key 重试，系统不因 429 禁用任一账号

### Requirement: 生成请求并发限制

系统 SHALL 限制同一 API key 下同时进行的生成请求数，不超过配置的并发上限（默认 1）。当某 key 的在途请求数达到上限时，新的生成请求 SHALL 排队等待，在前序请求释放（流结束、失败或取消）后按先来先服务顺序开始，而非立即失败；排队期间或进行中的请求被取消 SHALL 不占用或立即释放额度。并发上限 SHALL 从设置命名空间读取，未配置、非正整数或无法解析时 SHALL 回退为 1。并发闸 SHALL 仅作用于生成请求（`/chat/completions`），SHALL NOT 作用于模型目录拉取。

#### Scenario: 未超限直接放行

- **WHEN** 某 key 的在途生成请求数小于并发上限
- **THEN** 新请求立即开始，不经过排队等待

#### Scenario: 达到上限时排队

- **WHEN** 某 key 的在途生成请求数达到并发上限
- **THEN** 新请求排队等待，在前序请求释放额度后开始，不被立即以错误拒绝

#### Scenario: 上限为一时串行

- **WHEN** 并发上限为 1 且多个生成请求并发进入
- **THEN** 请求按到达顺序串行开始，同一时刻该 key 至多有一个在途生成请求

#### Scenario: 流结束释放额度

- **WHEN** 某生成请求的流式输出结束（正常 finish 或错误终止）
- **THEN** 该 key 的一个并发额度被释放，排队中的下一个请求得以开始

#### Scenario: 取消不占用额度

- **WHEN** 排队中或进行中的生成请求被取消
- **THEN** 该请求不占用或立即释放并发额度，不影响其他请求的排队顺序

#### Scenario: 非法配置回退默认

- **WHEN** 并发上限未配置、非正整数或无法解析为数字
- **THEN** 按默认值 1 生效，不因非法值中断请求处理

### Requirement: 401 禁用账号

系统 SHALL 在收到 401 响应时将该账号的 key 标记为禁用，直到该 key 值在凭据服务中被修改。

#### Scenario: 401 禁用

- **WHEN** 某账号请求收到 401
- **THEN** 该账号被标记为禁用，后续请求不再选中它，直到存储的 key 值改变

### Requirement: 轮换与耗尽错误

系统 SHALL 在账号密钥失效（401）时自动切换到下一个可用账号；当所有账号都被 401 禁用时应给出明确错误。429 默认不触发轮换；仅当 `quotaRotation` 开启且响应属于配额类 429 时，系统才按「429 不冷却不轮换」需求切换到下一把可用 key 并粘住，非配额类 429 不触发轮换。

#### Scenario: 401 触发自动轮换

- **WHEN** 当前账号在响应头返回前收到 401，且存在尚未尝试的可用账号
- **THEN** 系统标记该账号为禁用并改用下一个可用账号重试，每个 key 至多尝试一次

#### Scenario: 全账号被 401 拒绝

- **WHEN** 所有已配置账号均返回 401
- **THEN** 系统以 `INVALID_CREDENTIAL` 错误结束请求

### Requirement: 流式生成

系统 SHALL 以 OpenAI 兼容协议调用 `{apiBase}/chat/completions`，将 SSE 响应翻译为宿主流式块（文本、推理、工具调用、用量、结束），每个出站请求 SHALL 携带 `attributionHeaders()`；当请求因模型不可路由被拒绝时，系统 SHALL 给出明确的模型不可用错误。

系统 SHALL 同时接受 `delta.reasoning_content`（DeepSeek/Kimi 系）与 `delta.reasoning`（SenseNova 6.8 系）作为推理增量，任一字段的增量 SHALL 映射为宿主 reasoning 块增量，不得因字段名差异丢弃思考过程。

系统 SHALL 将 `delta.tool_calls` 分片按 `index` 优先聚合：同一 `index` 的分片归入同一工具槽；无 `index` 但有稳定 `id` 时按 `id` 聚合；两者皆无时按分片出现顺序自增开槽；槽内 `id`/`name` 增量覆盖，`arguments` 增量拼接，聚合结果 `name` 非空且 `arguments` 为完整 JSON 文本。

#### Scenario: 正常流式生成

- **WHEN** 用户以 `sensenova` 路由发起生成请求
- **THEN** 系统向 `{apiBase}/chat/completions` 发送请求，并将 SSE 流翻译为宿主流式块直至 `finish`

#### Scenario: 模型不可路由

- **WHEN** 响应返回 404 且错误信息为 `model route not found` 或 `model is not found`
- **THEN** 系统以明确的模型不可用错误结束本次生成，而非抛出一个无上下文的通用 404

#### Scenario: 流开始后失败不回放

- **WHEN** SSE 已开始输出内容后请求失败
- **THEN** 系统以该错误结束本次生成，不将已消费的生成回放到另一账号

#### Scenario: 透传思考档位

- **WHEN** 宿主为某模型选定 `reasoning_effort`，该值在模型档位表（或目录词表）值域内
- **THEN** 出站请求体包含与选定值一致的 `reasoning_effort`，不做值域改写或丢弃；命中 deepseek-flash 兼容映射（`minimal`→`low`、`medium`/`xhigh`→`high`、`ultra`→`max`）或值域外时按「Chat 请求体字段分派」处理，不发送模型不认识的档位值

#### Scenario: 两种推理增量字段都被显示

- **WHEN** SSE 事件中 `delta.reasoning_content` 或 `delta.reasoning` 任一字段携带文本
- **THEN** 系统将对应文本作为 reasoning 块增量发射；两个字段都有值时按 `reasoning_content` 优先、`reasoning` 兜底，不重复发射

#### Scenario: 规范 index 并行工具分片聚合

- **WHEN** SSE 以带 `index` 的并行 `tool_calls` 分片流式返回多个工具（如 `index 0` 与 `index 1` 各自分片到达）
- **THEN** 经宿主组装后产出与工具数一致的 `tool-call` 块，每个块的 `name` 非空、`arguments` 为该工具完整合法的 JSON 文本，分片不串槽不错位

#### Scenario: 无键并行工具分片聚合

- **WHEN** SSE 的并行 `tool_calls` 分片既无 `index` 也无 `id`，多个工具的分片交错到达
- **THEN** 各工具按出现顺序分入独立槽，经宿主组装后每个 `tool-call` 块 `name` 非空、`arguments` 完整，不出现多工具 arguments 拼接或空 `name` 块

### Requirement: 模型目录

系统 SHALL 从 `{apiBase}/models` 实时获取模型目录，并将 host 自动目录作为唯一事实来源；仅暴露可作为对话模型路由的条目：`output_modalities` 必须包含 `text`，且条目 id 不得命中已知不可路由清单或进程内失败缓存。系统 SHALL 从目录字段声明每个模型的输入模态与标准可读显示名。旧配置中的 `modelSelection.include` 与 `modelSelection.exclude` SHALL 被忽略，不能改变目录结果；设置保存 SHALL NOT 主动回写或清理这些未知旧字段。在没有任何可用 key 时返回空目录而不阻塞路由注册。

#### Scenario: 拉取模型目录
- **WHEN** 存在至少一个可用账号 key
- **THEN** 系统调用 `{apiBase}/models` 并返回端点声明的文本对话模型，目录不受任何手动模型覆盖影响

#### Scenario: 拉取并过滤模型目录
- **WHEN** 存在至少一个可用账号 key，且端点返回的目录包含文生图模型（`output_modalities` 不含 `text`）与已知不可路由模型 `sensenova-6.7-flash-lite`
- **THEN** 系统调用 `{apiBase}/models`，只返回 `output_modalities` 含 `text` 且未被标记不可路由的对话模型，文生图模型与已知 stale 模型被排除

#### Scenario: 运行时剔除未知 stale 模型
- **WHEN** 某个目录中的文本模型请求返回 `MODEL_NOT_FOUND`
- **THEN** 系统将该模型 id 写入进程内失败缓存，后续成功的 `listModels()` 不再返回该模型，直到适配器生命周期结束

#### Scenario: 声明多模态输入
- **WHEN** 目录中某模型的 `input_modalities` 含 `image`
- **THEN** 系统将该模型的 `inputModalities` 声明为 `['text', 'image']`，而非硬编码的 `['text']`

#### Scenario: 标准显示名
- **WHEN** `resolveModel()` 解析模型 id `sensenova-6.7-flash-lite`
- **THEN** 系统以标准名称 `Sensenova 6.7 Flash Lite` 返回该模型元数据，而非原始 id

#### Scenario: 无 key 时不阻塞
- **WHEN** 没有任何账号解析出 key
- **THEN** 系统返回空模型目录，路由仍保持已注册状态

#### Scenario: 凭据桥接异常可诊断

- **WHEN** 凭据服务返回 `INVALID_CREDENTIAL`、标记已配置但解析为空，或其他非 `MISSING_CREDENTIAL` 解析错误
- **THEN** 系统将错误交给宿主模型目录层，`modelCatalog.failures` SHALL 暴露来源/可写性等不含密钥的诊断信息，而非静默返回空分组

#### Scenario: 旧 modelSelection 被忽略
- **WHEN** 用户设置中仍存在 `modelSelection.include` 或 `modelSelection.exclude`，且其值试图重新加入 stale 模型或隐藏自动目录模型
- **THEN** 系统忽略这些字段，目录仍严格遵循最新 `{apiBase}/models`、自动过滤和失败缓存结果

#### Scenario: 保存不回写或清理未知旧字段
- **WHEN** 用户保存其他 SenseNova 设置，且原配置仍含未知的 `modelSelection` 字段
- **THEN** 系统不主动回写、迁移或清理该字段，但该字段继续不影响目录

### Requirement: Web 设置页

系统 SHALL 提供 Web 设置页，允许配置默认账户密钥、增删账户并通过下拉选择活动账户，并在宿主 Models 页提供 provider 卡片。设置页 SHALL NOT 展示凭据引用名、手动加入模型输入或隐藏模型输入；模型可见性唯一服从 host 自动目录。低频配置字段 SHALL 收纳进默认折叠的高级设置区域；轮换说明文案 SHALL 与实际轮换行为一致：仅 401 自动切换账户；`quotaRotation` 关闭时 429 不切换，开启时仅配额类 429 可切换到下一把 key 并粘住。

配置状态与路由徽标 SHALL 采用中性配色而非强调色：已配置/已启用徽标 SHALL 使用中性平台底色与次要文字色，未配置徽标 SHALL 仅用弱化文字色区分，不使用 success 绿作为徽标背景。「活动」为选中态指示而非配置状态，SHALL 使用实心高对比填充（主色底 + 反色前景）以与中性状态徽标明确区分。

页面底部操作区 SHALL 右对齐排列，重置 SHALL 呈现为带描边/透明底的次按钮（ghost），保存 SHALL 为高亮主按钮（primary）；主按钮文字 SHALL 使用反色前景（`label-primary-foreground`）而非 `label-primary`，确保浅/深主题下均与主色背景高对比可见；保存失败/成功/未保存状态消息 SHALL 与按钮行分离展示，不混排于同一行。

凭据配置状态徽标 MUST 反映凭据服务的真实持久化状态，不受设置快照加载时序影响：当设置快照从加载中转变为就绪（或页面涉及的 credential-ref 集合因此变化）时，系统 SHALL 重新查询这些引用的配置状态并更新徽标，不得因首次查询发生在快照就绪之前而将已持久化的账户残留显示为「未配置」。

系统 SHALL 在高级设置折叠区提供「并发上限」数字输入字段（默认值 1，仅接受正整数），用于配置每个 API key 的同时生成请求数上限（见「生成请求并发限制」需求）。高级设置 SHALL 可展示模型由 host 自动管理的说明，但 SHALL NOT 提供任何手动模型加入或隐藏控件。

#### Scenario: 设置页可配置多账号
- **WHEN** 用户打开设置页的 sensenova 区域
- **THEN** 用户可以配置默认账户密钥、增删账户并通过下拉框选择活动账户；API 地址、并发上限与配额类 429 换 key 开关位于高级设置折叠区，页面不显示手动模型筛选控件

#### Scenario: 账户行单列布局
- **WHEN** 设置页渲染任一账户行
- **THEN** 行头部单行展示备注名标签、配置状态徽标与动作按钮且按钮文字不换行，备注名输入与密钥输入各占满整行宽度，账户之间以分隔线区隔而非嵌套边框盒

#### Scenario: 不展示凭据引用名
- **WHEN** 设置页渲染默认账户或任一账户行
- **THEN** 页面任何位置不出现 `SENSENOVA_API_KEY` 等凭据引用名，也不提供引用名编辑入口；密钥输入框仅接受密钥原文

#### Scenario: 活动账户下拉选择
- **WHEN** 用户使用活动账户下拉框
- **THEN** 选项为「自动（第一个可用账户）」与已保存账户，未保存的新增行不出现在选项中；点击重置后回到自动

#### Scenario: 高级设置折叠
- **WHEN** 用户打开设置页
- **THEN** 高级设置区域默认折叠，折叠头显示已自定义项数徽标；展开后可编辑 API 地址、并发上限与配额类 429 换 key 开关，并显示模型由 host 自动管理的说明，不出现手动加入模型或隐藏模型输入

#### Scenario: 轮换文案与行为一致
- **WHEN** 设置页渲染多账户轮换说明与「配额类 429 换 key」开关
- **THEN** 文案明确表述「密钥失效（401）时自动切换到下一个可用账户；默认 429 限流不切换账户、由宿主重试层退避后原 key 重试；开启开关后仅配额类 429 可切换并粘住新 key」

#### Scenario: 徽标不使用绿色强调
- **WHEN** 设置页或 Models 页卡片渲染「已配置」「未配置」「已启用」状态徽标与路由徽标
- **THEN** 徽标使用中性底色或弱化文字色，任何状态均不以 success 绿色作为背景色

#### Scenario: 主按钮文字反色前景
- **WHEN** 设置页渲染底部操作区且存在未保存变更
- **THEN** 保存主按钮文字采用反色前景令牌，浅色主题下主色底 + 反色文字、深色主题下同样高对比，文字清晰可读而非与背景同色

#### Scenario: 活动账户徽标高对比
- **WHEN** 设置页渲染被钉选的账户行（`activeAccount` 指向该账户 id）
- **THEN** 该账户行显示实心高对比的「活动」徽标（主色底 + 反色文字），与「已配置/未配置」中性徽标在视觉上明确区分

#### Scenario: 自动模式显示实际生效账户
- **WHEN** 活动账户为「自动」且存在已配置账户
- **THEN** 页面显示当前实际生效账户的可识别标记：默认账户已配置时标记默认账户，否则标记第一个已配置账户行，用户无需切换即可识别生效账户

#### Scenario: 并发上限字段
- **WHEN** 用户展开高级设置
- **THEN** 出现「并发上限」数字输入字段，默认值为 1，仅接受正整数；保存后该值随设置持久化并热生效

#### Scenario: 底部操作右对齐且重置为次按钮
- **WHEN** 设置页渲染底部操作区且存在未保存变更
- **THEN** 重置为 ghost 样式次按钮、保存为主按钮，二者靠右对齐；状态消息不与按钮同处一行

#### Scenario: 保存反馈短暂显示
- **WHEN** 用户保存成功
- **THEN** 「已保存 ✓」反馈显示并在约 2.5 秒后自动消失

#### Scenario: 快照就绪后徽标反映真实配置
- **WHEN** 用户已保存某额外账户的 API key（凭据与设置均已持久化），随后重新打开设置页，且设置快照在凭据状态首次查询之后才从加载中转变为就绪
- **THEN** 该账户行的配置状态徽标显示「已配置」，Models 页卡片的已配置账户计数同样计入该账户，而非残留「未配置」

#### Scenario: Models 页显示卡片
- **WHEN** 宿主 Models 设置页渲染 sensenova 行
- **THEN** 显示该 provider 的卡片，卡片具备完整的容器样式（边框、圆角、内边距），提供进入设置页的入口

### Requirement: 凭据隐私

系统 SHALL 仅通过宿主凭据服务解析 API key，key 原文 SHALL NOT 写入日志或发送给任何模型或第三方。

#### Scenario: key 不落日志

- **WHEN** 系统解析、轮换或报错时涉及 API key
- **THEN** 日志与错误信息中不出现 key 原文，仅出现凭据引用名或账号标签

### Requirement: 模型能力自动配置

系统 SHALL 在 `listModels()` 获取目录后缓存每个模型的能力元数据，并在 `resolveModel()` 中按模型 id 自动生成对应配置：上下文大小优先取目录的 `context_length`、`context_window`、`max_context_length` 或 `contextLength`；最大输出优先取 `max_output_length`、`max_tokens`、`max_output_tokens`、`max_completion_tokens` 或对应驼峰字段（`max_output_length` 为 SenseNova 目录实际字段名，SHALL 优先识别）；输入模态取目录 `input_modalities`。

系统 SHALL 按以下优先级声明思考档位（`reasoning.efforts`）：目录提供档位词表时采用目录词表；否则模型 id 命中内置模型族档位表时采用该表并 SHALL 同时声明对应的 `defaultEffort`；两者皆无时不声明思考档位，SHALL NOT 虚构档位。每个 effort id SHALL 原样保留为 wire value 并包装为宿主 `ReasoningEffortId`（deepseek-flash 的兼容映射除外，见「内置模型档位表」）。

#### Scenario: 按目录配置上下文大小

- **WHEN** `listModels()` 返回某模型的 `context_length` 为 `262144`，随后调用该模型的 `resolveModel()`
- **THEN** 返回的 `context.contextWindow` 为 `262144`，而不是通用的固定默认值

#### Scenario: 按目录配置最大输出

- **WHEN** 目录为某模型声明 `max_output_tokens` 或等价最大输出字段
- **THEN** `resolveModel()` 返回对应的 `defaultMaxTokens`，供宿主自动配置请求上限

#### Scenario: 识别 SenseNova 目录的 max_output_length 字段

- **WHEN** `/models` 目录以 `max_output_length: 65536` 声明某模型（如 `deepseek-v4-flash`）的最大输出，且不含 `max_tokens` 等 OpenAI 风格字段，随后调用该模型的 `resolveModel()`
- **THEN** 返回的 `defaultMaxTokens` 为 `65536`，宿主在用户未显式设置上限时将其作为请求上限下发，模型输出不再受服务端默认上限（8192）截断

#### Scenario: 按目录配置思考级别

- **WHEN** 目录为某模型提供 `reasoning_efforts` 词表 `low`、`medium`、`high`，并声明 `medium` 为默认级别
- **THEN** `resolveModel()` 将相同 wire value 映射到 `reasoning.efforts` 与 `reasoning.defaultEffort`，静态表不参与覆盖

#### Scenario: 目录仅标记支持但未提供词表

- **WHEN** 模型目录只有 `reasoning_effort`、`thinking` 或 `supported_features: ["reasoning"]` 支持标记，没有可选级别词表
- **THEN** 模型 id 命中内置模型族档位表时，`resolveModel()` 返回该表的 `reasoning.efforts` 及其 `defaultEffort`；id 不在表中时保持该项未知，不虚构思考级别

#### Scenario: 目录刷新后同步能力

- **WHEN** 再次调用 `listModels()` 后同一模型的上下文大小或思考档位发生变化
- **THEN** 后续 `resolveModel()` 使用最新目录值（静态表仍按其 id 生效），不继续使用旧缓存

### Requirement: Provider 重试策略

系统 SHALL 为 `sensenova` 路由声明 `normal` 重试策略：最大重试次数 SHALL 为有限值且默认不超过 100 次（宿主按步骤边界重置计数，该上限为单个 agent 步骤内的预算；100 次配合 15s 封顶档位覆盖约 25 分钟恢复窗口，更长故障仍显式失败）；本地指数退避单次延迟上限 SHALL 不低于 60000 毫秒且不超过 300000 毫秒（60000 毫秒 ≤ 上限 ≤ 300000 毫秒）。收到配额类 429（见「429 不冷却不轮换」）后的下一次重试延迟 SHALL 不低于该错误携带的 `providerRetryAfterMs`（TPM 类为该会话当前分级探测档位，code 8 为 15000 毫秒）。对非配额类 429，服务端提供的 `Retry-After` 超过单次延迟上限时 SHALL NOT 作为 provider 延迟透传，也不得截断后透传，改由本地策略计算；配额类的 `Retry-After` 采用规则见「429 不冷却不轮换」。429 不产生账号冷却。

#### Scenario: 持续限流时重试预算有限

- **WHEN** 请求连续收到配额类 429 且每次退避后重试仍失败
- **THEN** 宿主在不超过声明上限的有限重试次数内停止，向会话暴露明确的 `RATE_LIMIT` 失败，而不是以 3 秒级短退避持续重试上千次

#### Scenario: 配额类退避下限被遵守

- **WHEN** 某次配额类 429 携带 `providerRetryAfterMs` 10000 毫秒（TPM 分级第 3 档）
- **THEN** 下一次重试的实际延迟不低于 10000 毫秒，本地指数退避在达到单次延迟上限后不再增长

#### Scenario: 限流时按策略重试

- **WHEN** 请求收到 429 限流响应且未提供超过单次延迟上限的 `Retry-After`
- **THEN** 宿主按该路由声明的策略重试，重试次数不超过声明的有限上限；配额类 429 的下一次重试延迟不低于其 `providerRetryAfterMs`

#### Scenario: 本地退避延迟封顶

- **WHEN** 本地退避延迟按指数增长
- **THEN** 单次重试延迟在达到声明的单次延迟上限后 SHALL NOT 继续增长，即使 jitter 生效也不得超过该上限

#### Scenario: 超长 Retry-After 不突破上限

- **WHEN** 非配额类 429 响应的 `Retry-After` 超过声明的单次延迟上限
- **THEN** 插件不向宿主透传该超长 `providerRetryAfterMs`，宿主使用本地退避策略继续重试，单次延迟不超过声明的上限

### Requirement: 生成请求超时与看门狗

系统 SHALL 为发往 `{apiBase}/chat/completions` 的生成请求提供超时保护：请求建立到收到首个响应字节 SHALL 受连接超时约束（默认 45000 毫秒量级）；SSE 流读取 SHALL 受空闲看门狗约束（默认 60000 毫秒量级，收到任一流式事件即重置）；并发闸排队等待 SHALL 受排队超时约束（默认 60000 毫秒量级）。任一超时触发时，系统 SHALL 释放该请求持有的并发额度，并以可重试的 `TIMEOUT` 错误交宿主重试层处理，不得让请求无限挂起或长期占用并发额度。

#### Scenario: 传输挂起不长期占用额度

- **WHEN** 生成请求发出后服务端长时间不返回首字节且超过连接超时
- **THEN** 系统以 `TIMEOUT` 错误结束本次请求并释放其并发闸额度，宿主可按重试策略重试

#### Scenario: 流中途停摆被看门狗回收

- **WHEN** SSE 流已开始输出后超过空闲看门狗时长未收到任何新事件
- **THEN** 系统以 `TIMEOUT` 错误结束本次生成并释放并发额度，不继续无限等待

#### Scenario: 排队超时交还宿主重试层

- **WHEN** 请求在并发闸队列中等待超过排队超时时长仍未获得额度
- **THEN** 系统以可重试错误结束排队等待（不占额度），由宿主重试层按退避策略再次发起

### Requirement: 内置模型档位表

系统 SHALL 维护内置模型族档位表，值域与默认档以官方文档为准，命中时随 `reasoning.efforts` 声明 `defaultEffort`。各模型具体值域：`sensenova-6.8-flash-lite` 与 `deepseek-v4-flash` 为 `low`/`medium`/`high`/`max`/`none`（默认 `high`）；`deepseek-flash` 原生 `none`/`low`/`high`/`max`（默认 `high`）另按兼容映射接受 `minimal`/`medium`/`xhigh`/`ultra`；`glm-5.2` 为 `max`/`xhigh`/`high`/`medium`/`low`/`minimal`/`none`（默认 `max`）；`kimi-k3` 为 `low`/`medium`/`high`/`max`（默认 `max`，`none` 经 `thinking: "disabled"` 表达）。已下线的 `deepseek-v4-pro` SHALL NOT 保留条目。

#### Scenario: glm-5.2 默认档正确标注

- **WHEN** `resolveModel()` 解析 `glm-5.2` 且目录未提供档位词表
- **THEN** 返回七档 `reasoning.efforts` 且 `defaultEffort` 为 `max`，宿主选择器不再把默认档错误显示为 `high`

#### Scenario: deepseek-v4-pro 条目移除

- **WHEN** 用户或宿主查询 `deepseek-v4-pro` 的模型能力
- **THEN** 该 id 不命中内置档位表，`resolveModel()` 不为其声明档位，除非目录另行提供词表

#### Scenario: deepseek-flash 兼容映射

- **WHEN** 宿主为 `deepseek-flash` 选定 `reasoning_effort` 为 `minimal`、`medium`、`xhigh` 或 `ultra`
- **THEN** 出站请求体的 `reasoning_effort` 分别为映射后的 `low`、`high`、`high`、`max`

### Requirement: Chat 请求体字段分派

系统 SHALL 按模型分派出站 Chat 请求字段：输出上限 kimi-k3 使用 `max_completion_tokens`、其余模型使用 `max_tokens`；流式请求对支持模型显式发送 `stream_options: {include_usage: true}`，glm-5.2 SHALL NOT 发送 `stream_options`；请求携带 `tools` 且模型为 deepseek-v4-flash / deepseek-flash 时 SHALL 回放全部历史轮次 `reasoning_content`，其余模型或无 `tools` 时 SHALL NOT 回传；glm-5.2 SHALL NOT 发送任何 `thinking` 字段；kimi-k3 SHALL NOT 发送 `frequency_penalty`、`presence_penalty`、`temperature`、`top_p`；目录 `supported_sampling_parameters` 未列出的采样字段 SHALL NOT 发送。

#### Scenario: kimi-k3 输出上限字段名

- **WHEN** 用户对 `kimi-k3` 设置输出上限
- **THEN** 出站请求体以 `max_completion_tokens` 携带该值，不发送 `max_tokens`

#### Scenario: 显式 stream_options

- **WHEN** 对 6.8-flash-lite / deepseek-v4-flash / deepseek-flash / kimi-k3 发起流式请求
- **THEN** 请求体显式包含 `stream_options: {include_usage: true}`，流式用量不依赖服务端默认值；对 glm-5.2 发起流式请求时请求体不含 `stream_options` 字段

#### Scenario: deepseek 系带工具时回放思维链

- **WHEN** 对 deepseek-v4-flash 或 deepseek-flash 发起携带 `tools` 的多轮请求，且历史 assistant 消息含 `reasoning_content`
- **THEN** 出站 `messages` 中历史 assistant 项保留 `reasoning_content` 原文；同一请求不带 `tools` 时不携带该字段

#### Scenario: 非 deepseek 系不回传思维链

- **WHEN** 对 6.8-flash-lite / glm-5.2 / kimi-k3 发起多轮请求
- **THEN** 出站历史 assistant 项仅携带 `content` 与工具调用结构，不含 `reasoning_content`

#### Scenario: glm-5.2 禁发 thinking

- **WHEN** 宿主为 glm-5.2 关闭思考（等价 `none`）
- **THEN** 请求体通过 `reasoning_effort: "none"` 表达，不出现任何 `thinking` 字段，请求不因 `thinking.type=disabled` 被网关拒绝

#### Scenario: 按目录裁剪采样字段

- **WHEN** 目录为某模型返回 `supported_sampling_parameters` 且不含某采样字段（如 `seed`），而宿主请求携带了该字段
- **THEN** 出站请求体省略该字段，不发送模型不支持的采样参数

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

### Requirement: 图像内容块翻译

系统 SHALL 提供内容块翻译抽象，将宿主消息中的图像块按所选协议翻译为出站项：Chat Completions 分支输出 `{type:'image_url', image_url:{url}}`；Responses 分支输出扁平的 `{type:'input_image', image_url:<URL 或 data URL>}` 并与 `{type:'input_text'}` 文本项并列。翻译 MUST 复用宿主经 dsh-llm re-export 的 attachment 能力（`contentHasImage`/`projectImagesForTextModel`/`offloadRequestImagesWithPolicy`），MUST NOT 自造等价物。

#### Scenario: 双分支形态

- **WHEN** 同一含图请求分别走 chat 与 responses 协议
- **THEN** chat 分支出 `image_url` 嵌套形态、responses 分支出扁平 `input_image` 形态，文本分别以 text 项与 input_text 项携带

#### Scenario: 图像存在检测

- **WHEN** 请求内容含图像块
- **THEN** 经宿主 `contentHasImage` 判定后进入图像翻译路径，不再静默丢弃

### Requirement: 图像能力分派

图像出站行为 MUST 按模型能力分派（消费 ModelFacts 的 supportsImages/imageFormats/imageRequiresBase64）：多模态模型（6.8-flash-lite、deepseek-flash、kimi-k3）按各自格式集发送；纯文本模型（如 deepseek-v4-flash、glm-5.2，文档无图像章节）收到图像块时经宿主 `projectImagesForTextModel` 投影处理；`imageRequiresBase64` 为真（kimi-k3）且图像为公网 URL 时按既定降级策略处理，base64 data URL 直传。不支持的视频与 `input_file` 类型不在范围内。

#### Scenario: 纯文本模型投影

- **WHEN** deepseek-v4-flash 或 glm-5.2 的请求携带图像块
- **THEN** 图像经宿主投影函数处理为文本模型可接受的形态，请求不因图像失败

#### Scenario: kimi-k3 URL 降级

- **WHEN** kimi-k3 请求携带公网 URL 图像
- **THEN** 按降级策略处理（见 design），base64 data URL 图像原样直传

### Requirement: 图像限制校验

系统 SHALL 按官方文档声明各模型图像限制并在出站前校验：6.8-flash-lite 支持 jpg/jpeg/png/webp（公网 URL 或 base64）；deepseek-flash 支持 JPEG/PNG/GIF/WebP（单图 50MB、总 64MB、最多 200 张、URL 总量 200MB）；kimi-k3 支持七种格式但仅 base64；Responses 协议 input_image 支持 png/jpeg/gif/webp。超限或格式不支持时 MUST 给出明确错误或受控降级，MUST NOT 静默发送注定失败的请求。

#### Scenario: 格式不支持

- **WHEN** 模型格式集不含某图像格式（如向 6.8 发 BMP）
- **THEN** 出站前报明确错误说明支持的格式，不发送请求

#### Scenario: 大小与数量超限

- **WHEN** deepseek-flash 请求单图超 50MB 或张数超 200
- **THEN** 出站前拦截并报错说明限制数值
