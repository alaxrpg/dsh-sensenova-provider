# sensenova-provider Specification

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: 手动模型可选覆盖

**Reason**: host `/models` 自动目录已是唯一事实来源；保留 include/exclude 会形成第二套模型可见性来源，并允许旧配置绕过自动不可路由/失败过滤，属于 BREAKING 行为变更。

**Migration**: 用户无需迁移操作。已有 `modelSelection.include`/`exclude` 字段将被忽略且不再影响目录；设置保存不会主动回写或清理未知旧字段。需要隐藏或重新加入模型时，应依赖 host 下一次 `/models` 目录及既有自动过滤结果，而不能继续使用手动覆盖。

#### Scenario: 手动覆盖不再生效
- **WHEN** 用户配置 `modelSelection.include` 或 `modelSelection.exclude`
- **THEN** 系统不应用这些覆盖，目录严格遵循 host 自动目录与自动过滤规则
