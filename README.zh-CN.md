# @alaxrpg/dsh-sensenova-provider

非官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）LLM 提供商插件，对接 **SenseNova**（OpenAI 兼容 API）。注册 `sensenova` 提供商路由，附带 Models 页卡片、实时模型目录，以及**单共享 baseURL 上的多账户 API-key 轮换**。

> 参考实现：[`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider)（MIT）。本插件只保留多账户连接能力；登录流程、用量面板、套餐窗口、命令行工具均已裁剪。

## 功能

- 注册提供商路由 `sensenova`（显示名 **SenseNova**）。
- 实时模型目录：`GET {apiBase}/v1/models`。
- OpenAI 兼容流式输出：`POST {apiBase}/v1/chat/completions`（SSE）。
- 单个共享 baseURL 上的多个 API 密钥（账户），自动轮换：
  - `429 Too Many Requests` → 冷却该密钥（尊重 `Retry-After`；缺失时兜底 60 s）。
  - `401 Unauthorized` → 禁用该密钥，直到存储的凭据发生变化。
  - 全部密钥耗尽 → 以 `RATE_LIMIT` / `INVALID_CREDENTIAL` 暴露最早恢复时间。
- Web 设置页（Models 页卡片 + 独立设置页）。

## 环境要求

- DSH 宿主 `>=0.1.2-alpha.3`（alpha 线）。
- Node.js `>=22`。

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
