## Context

当前 `src/index.ts` 在 `SensenovaConfig`、Schemastery `Config`、`resolveAdapterOptions()` 及 adapter options 注入链中保留 `modelSelection`；`src/adapter.ts` 的 `parseCatalog()` 依据 include/exclude 改写自动过滤结果。`src/client/settings.ts` 的设置类型仍声明该字段，`src/client/locales.ts` 仍有手动模型文案。设置组件 `src/client/section.tsx` 已不再渲染手动模型输入，仅显示自动管理提示，但后端类型、解析和 adapter 逻辑仍是残留。现有 adapter 测试仍验证手动覆盖行为。详见 `proposal.md` 的动机与范围；本设计落实其 BREAKING 决策。

## Goals / Non-Goals

**Goals:**

- 删除 `modelSelection.include/exclude` 的 schema、配置类型、解析输出和 adapter 选项传递，使 `/models` 自动目录成为唯一模型来源。
- 保留 `output_modalities` 文本过滤、已知不可路由清单、进程内失败缓存、输入模态和目录能力元数据解析。
- 确保设置页不展示手动加入/隐藏控件及相关文案；保存其他字段时不主动回写或清理未知旧字段。
- 通过测试证明旧配置被忽略、不会合成或隐藏目录条目，并验证自动目录元数据和过滤行为不回归。

**Non-Goals:**

- 不修改 host `/models` 接口、provider 注册、凭据、账户轮换、请求协议或重试策略。
- 不新增配置迁移器，不负责清理用户设置中未知字段。
- 不改变自动过滤规则、模型元数据优先级或 stale 失败缓存生命周期。

## Decisions

1. **彻底移除字段，而非仅隐藏 UI。** 从 `src/index.ts` schema/类型/解析链、`src/adapter.ts` 连接类型与目录解析、`src/client/settings.ts` 类型中移除 `modelSelection`，避免后端仍可通过未渲染字段改变目录，消除第二事实来源并使 BREAKING 行为可验证。备选方案是只删除 `section.tsx` 控件（会留下隐式 API）或保留字段但忽略（仍扩大类型/schema 表面），均不采用。
2. **目录以 host 自动 `/models` 为唯一来源。** `parseCatalog()` 仅按现有文本输出、不可路由清单和失败缓存过滤，不引入手动集合，也不凭配置合成目录项；目录条目的输入模态、显示名、上下文、最大输出和 reasoning 元数据解析保持原顺序。备选方案是把覆盖移至 host 或新增本地 allowlist，都会重建第二来源，超出本变更范围。
3. **未知旧字段只读忽略，不主动清理。** 配置保存继续由宿主 settings 机制处理；插件不执行迁移/回写/删除未知字段。读取时 schema/解析不消费 `modelSelection`，因此旧值自然不影响目录，同时避免破坏用户配置的隐式清理。备选方案是保存时清理字段，虽能减少残留但会产生隐式数据修改，故不采用。
4. **设置 UI 与 locales 同步收口。** 保持现有自动管理提示和高级设置结构，删除 include/exclude 的领域类型与中英文文案；不为已经不存在的控件添加新的交互。备选方案是保留废弃说明文案，可能暗示功能仍可用，故不采用。
5. **测试覆盖行为契约而非实现细节。** 替换原手动覆盖测试为旧配置忽略测试，分别覆盖 stale 不恢复、可见模型不被隐藏、image-only 仍排除、未知 id 不合成、保存不清理；保留并加强自动过滤和目录元数据测试。

## Risks / Trade-offs

- [Risk] 依赖手动 include/exclude 的用户在升级后看不到原先强制显示或隐藏的模型。 → Mitigation：在变更说明和迁移验收中明确 BREAKING；目录行为以 host 最新 `/models` 和既有自动过滤为准。
- [Risk] 删除类型后，外部程序化配置仍可能携带旧字段。 → Mitigation：解析链忽略未知字段且不回写/清理；增加旧配置兼容验收测试，确保不会影响目录。
- [Risk] 删除 locales 键导致客户端仍有旧 bundle 引用时出现缺文案。 → Mitigation：全局搜索引用并在构建/类型检查中验证，仅保留实际使用的自动管理提示键。
- [Risk] 调整 parseCatalog 签名造成测试或调用点遗漏。 → Mitigation：按 adapter/catalog 调用链统一修改并运行相关测试与 OpenSpec 校验。

## Migration Plan

1. 先更新 schema/config 类型和 adapter/catalog 调用链，移除字段消费；再清理 settings 类型与 locales 残留，并确认 UI 仍仅显示自动管理提示。
2. 更新 adapter/settings 测试，验证旧值被忽略且保存不主动清理；运行项目既有构建、测试和 `openspec validate --strict`。
3. 发布为 BREAKING 版本。无需数据迁移脚本；旧 `modelSelection` 字段可暂留在宿主设置中，但不再被插件读取或写回。
4. 回滚时恢复旧版本插件即可重新解释仍存在的旧字段；回滚不依赖字段清理，因此不会因本版本保存操作丢失旧值。

## Open Questions

无。
