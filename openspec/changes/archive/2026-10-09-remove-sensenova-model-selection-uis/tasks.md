## 1. Schema / Config

- [x] 1.1 从 `src/index.ts` 的 `SensenovaConfig`、Schemastery `Config` 与 `ResolvedSensenovaOptions` 移除 `modelSelection` 字段及相关 `ModelSelection` 类型导入。
- [x] 1.2 删除 `normalizeModelIds()`、`normalizeModelSelection()` 及 `resolveAdapterOptions()` 中对旧字段的解析；确认其他设置保存路径不主动回写或清理未知 `modelSelection` 字段。
- [x] 1.3 从 `src/client/settings.ts` 的 `SenseNovaConfig` 移除 `modelSelection` 声明，并检查设置控制器的字段白名单/保存逻辑不生成该字段。

## 2. Adapter / Catalog

- [x] 2.1 从 `src/adapter.ts` 的 `ModelSelection`、`SensenovaConnection` 和空选择常量中移除手动覆盖类型与默认值。
- [x] 2.2 修改 `parseCatalog()` 及 `listModels()` 调用链，仅使用 host `/models` 响应、文本输出过滤、已知不可路由清单和进程内失败缓存；保持输入模态、显示名及能力元数据解析不变。
- [x] 2.3 从 `src/index.ts` 注入 adapter options 的路径移除 `modelSelection` 传递，并确保旧配置不会影响目录。

## 3. Settings / UI / Locales

- [x] 3.1 复核 `src/client/section.tsx`，确保高级设置只保留 API 地址、并发上限、配额类 429 换 key 开关及自动目录说明，不出现手动加入/隐藏模型输入。
- [x] 3.2 从 `src/client/locales.ts` 删除未使用的 `modelInclude`、`modelIncludeHint`、`modelExclude`、`modelExcludeHint` 中英文文案，并保留自动目录提示键及其翻译。
- [x] 3.3 全局检查 `src/client/` 的设置状态、字段编辑和高级设置计数，不将已废弃模型字段计入 UI 状态或保存载荷。

## 4. Tests

- [x] 4.1 替换 `tests/adapter.test.ts` 中手动 include/exclude 恢复、隐藏和刷新测试，新增旧 `modelSelection` 值被忽略的验收：stale 不恢复、可见模型不被隐藏、image-only 仍排除、未知 id 不合成。
- [x] 4.2 在设置控制器测试中加入验收：原配置含未知旧 `modelSelection` 时保存其他字段不会主动回写或清理该字段，且该字段不进入设置状态或 adapter 选项。
- [x] 4.3 保留并核对自动目录过滤、失败缓存剔除、输入模态、标准显示名和目录能力元数据测试，确保删除覆盖逻辑后行为不回归。
- [x] 4.4 更新受影响的类型/快照/客户端测试断言，确保设置页无手动模型控件和残留文案引用。

## 5. Build / Validation

- [x] 5.1 运行相关单元测试（adapter、settings）并记录命令与结果；失败时定位到具体文件和断言。
- [x] 5.2 运行项目既有类型检查、构建或打包命令，确认 schema、adapter、客户端 locales 引用完整，并确认生成的 lib 入口与 `package.json` 声明一致。
- [x] 5.3 运行 `openspec validate --strict`，确认 delta spec、design、tasks 结构、依赖和语言规则通过。
- [x] 5.4 执行验收复核：host 自动 `/models` 是唯一事实来源；旧配置被忽略但不主动清理；自动过滤和目录元数据保持不变；不得修改应用代码、主 spec、README、`.openspec.yaml`；仅保留用户已明确授权的 `tsdown.config.ts` 与 `lib` 构建产物改动，其他文件范围外内容不变。
