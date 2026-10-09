# Proposal: add-multimodal-input

## Why

多模态模型（6.8-flash-lite / deepseek-flash / kimi-k3）的图像输入当前被 `flattenText()`/`toolResultText()` 静默丢弃（P0-2，`src/adapter.ts:166-175`）：用户粘图无报错、无图、答非所问。宿主 `@deepseek-ai/dsh-llm` 已把 attachment 能力（`contentHasImage`/`projectImagesForTextModel`/`offloadRequestImagesWithPolicy`）作为一等公民 re-export，插件应复用而非自造。

## What Changes

- 新增 `src/wire/blocks.ts` 内容块翻译抽象：chat 分支输出 `{type:'image_url',image_url:{url}}`，responses 分支输出 `{type:'input_image',image_url:<URL 或 data URL>}`（扁平字段）+ `input_text` 文本项。
- 图像支持按模型能力分派（消费 ModelFacts 的 supportsImages/imageFormats/imageRequiresBase64）：纯文本模型图像经宿主投影处理；kimi-k3 仅 base64（URL 图像降级策略见 design）。
- 图像格式与大小限制按官方文档数值声明与校验。
- 视频块：宿主当前无 video 块类型，**out of scope**。

## Capabilities

- **New Capabilities**: 无
- **Modified Capabilities**: `sensenova-provider`（新增图像输入翻译与分派的 requirement；不修改主 spec 现有 requirement）

## Impact

- 代码：`src/wire/blocks.ts` 新增（chat/responses 双分支）；复用宿主 dsh-llm re-export 的三个 attachment 函数；`flattenText`/`toolResultText` 路径改走块翻译。
- 依赖：`add-model-facts`（supportsImages 等字段）与 `make-responses-default-wire-protocol`（responses wire 分支）。
- 兼容性：纯文本模型与不支持格式行为为受控投影/拒绝，替代静默丢弃。
