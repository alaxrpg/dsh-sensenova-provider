# @alaxrpg/dsh-sensenova-provider

Unofficial [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) LLM provider plugin for **SenseNova** (OpenAI-compatible API). Registers the `sensenova` provider route with a Models-page card, a live model catalog, and **multi-account API-key rotation** on a single shared base URL.

> Reference implementation: [`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider) (MIT). This plugin keeps only the multi-account connection feature; it drops login flows, usage dashboards, plan windows, and command-line tools.

## Features

- Registers provider route `sensenova` (display name **SenseNova**).
- Live model catalog via `GET {apiBase}/v1/models`.
- OpenAI-compatible streaming: `POST {apiBase}/v1/chat/completions` (SSE).
- Multiple API keys (accounts) on one shared base URL, with automatic rotation:
  - `429 Too Many Requests` → cooldown the key (honors `Retry-After`; 60 s fallback when absent).
  - `401 Unauthorized` → disable the key until the stored credential changes.
  - All keys exhausted → surfaces `RATE_LIMIT` / `INVALID_CREDENTIAL` with the earliest reset time.
- Web settings page (Models-page card + dedicated settings section).

## Requirements

- DSH host `>=0.1.2-alpha.3` (alpha line).
- Node.js `>=22`.

> Compatibility note: the runtime import surface is a stable subset of
> `@deepseek-ai/dsh-llm` present since `0.1.1-rc.2` (`LlmAdapter`, `LlmError`,
> `ReasoningEffortId`, `assertUsableApiKey`, `attributionHeaders`, `errorChain`,
> `resolveRetryPolicy`); the drifting `ToolCallId` symbol is defined locally
> (`src/brand.ts`, identity-backed). Runtime loading on `0.1.1-rc.2` hosts works;
> the declared peer floor `>=0.1.2-alpha.3` is the type-level support start
> (the `ToolCallId` type first appears there).

## Install

```bash
dsh plugin --profile <name> add dsh-sensenova-provider
```

Or install from a local path:

```bash
dsh plugin --profile <name> add ./dsh-sensenova-provider
```

Then configure **SenseNova** in the Models page: the default credential environment variable is `SENSENOVA_API_KEY`, and the default base URL is `https://token.sensenova.cn/v1`.

## Configuration

The plugin installs a `llm-sensenova` settings section with these fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `apiBase` | string | `https://token.sensenova.cn/v1` | Shared base URL for all accounts. |
| `apiKeyEnv` | credential-ref | `SENSENOVA_API_KEY` | Default account credential reference. |
| `accounts[]` | array | `[]` | Extra accounts: `{ id, label, apiKeyEnv }`. |
| `activeAccount` | string | `""` | Preferred account id; empty means auto / first usable. |

API keys are stored through the DSH credentials service; they are never logged and never sent to the model.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run build    # tsdown → lib/
pnpm test         # node --import tsx --test tests/**/*.test.ts
```

## License

MIT
