# @alaxrpg/dsh-sensenova-provider

非官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）LLM 提供商插件，对接 **SenseNova**（OpenAI 兼容 API）。注册 `sensenova` 提供商路由，附带 Models 页卡片、实时模型目录，以及**单共享 baseURL 上的多账户 API-key 轮换**。

> 参考实现：[`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider)（MIT）。本插件只保留多账户连接能力；登录流程、用量面板、套餐窗口、命令行工具均已裁剪。

## 功能

- 注册提供商路由 `sensenova`（显示名 **SenseNova**）。
- 实时模型目录：`GET {apiBase}/v1/models`。
- 双协议流式输出：`POST {apiBase}/v1/responses`（默认，见下）与 `POST {apiBase}/v1/chat/completions`（SSE；自动回退）。
- 单个共享 baseURL 上的多个 API 密钥（账户）：
  - `429 Too Many Requests` → **不冷却、不轮换**该密钥（保护服务端按 key 命中的 prompt 缓存），抛 `RATE_LIMIT` 交宿主重试层退避后原 key 重试（尊重 `Retry-After`，封顶 60 s；配额类 429 附带退避下限 `providerRetryAfterMs`）。开启 `quotaRotation` 后，仅配额类 429 粘性切换到下一把未试过的 key。
  - `401 Unauthorized` → 轮换到下一把 key；被拒 key 保持禁用，直到存储的凭据发生变化。
  - 全部密钥耗尽 → 以 `RATE_LIMIT` / `INVALID_CREDENTIAL` 暴露失败。
- Web 设置页（Models 页卡片 + 独立设置页）。
- 默认 wire 协议为 **Responses**（`auto` 模式）：能忠实表达的请求走 Responses，语义会丢失时（如带 `stop` 序列、思考档位偏离模型 Responses 默认档）自动降级 Chat Completions。Responses 的能力差异要点：`max_output_tokens` 计入推理 token、`temperature` 默认 0.6（Chat 为 1）、思维链仅以摘要回放、`stop` 不生效（自动降级 Chat）。
- 图像输入：生产环境图像出站依赖宿主 attachment 桥接（0.1.7-rc.2 适配器类型面暂无通道）；当前版本图像以宿主文本占位下发、不静默丢弃，桥接为后续宿主依赖项。

## 环境要求

- DSH 宿主 `>=0.1.2-alpha.3`（alpha 线）。
- Node.js `>=22`。

> 兼容性说明：运行时导入面是 `@deepseek-ai/dsh-llm` 自 `0.1.1-rc.2` 起就存在的稳定子集
> （`LlmAdapter`、`LlmError`、`ReasoningEffortId`、`assertUsableApiKey`、
> `attributionHeaders`、`errorChain`、`resolveRetryPolicy`）；漂移符号 `ToolCallId`
> 改为本地定义（`src/brand.ts`，恒等返回）。因此在 `0.1.1-rc.2` 宿主上可正常运行时加载；
> peer 下限 `>=0.1.2-alpha.3` 是类型支持起点（`ToolCallId` 类型首次出现于此版本）。

## 安装

```bash
dsh plugin --profile <name> add dsh-sensenova-provider
```

或从本地路径安装：

```bash
dsh plugin --profile <name> add ./dsh-sensenova-provider
```

随后在 Models 页配置 **SenseNova**：默认凭据环境变量为 `SENSENOVA_API_KEY`，默认 baseURL 为 `https://token.sensenova.cn/v1`。

## 配置

插件安装 `llm-sensenova` 设置段，包含以下字段：

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `apiBase` | string | `https://token.sensenova.cn/v1` | 所有账户共享的 baseURL。 |
| `apiKeyEnv` | credential-ref | `SENSENOVA_API_KEY` | 默认账户的凭据引用。 |
| `accounts[]` | array | `[]` | 额外账户：`{ id, label, apiKeyEnv }`。 |
| `activeAccount` | string | `""` | 首选账户 id；空表示自动 / 首个可用。 |
| `wireProtocol` | `auto`/`responses`/`chat-completions` | `auto` | wire 协议模式：`auto` 优先 Responses，语义会丢失时自动降级 Chat；强制 `responses` 时无法表达的场景直接报错；`chat-completions` 为兼容逃生舱。 |
| `reasoningSummary` | `auto`/`concise`/`detailed` | `auto` | 仅 Responses 生效：推理摘要（`reasoning.summary`）详略。 |

API 密钥经 DSH 凭据服务存储，绝不打印到日志、也绝不发送给模型。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm run build    # tsdown → lib/
pnpm test         # node --import tsx --test tests/**/*.test.ts
```

## 许可证

MIT
