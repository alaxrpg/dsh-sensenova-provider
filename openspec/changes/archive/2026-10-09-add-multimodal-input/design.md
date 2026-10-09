# Design: add-multimodal-input

## Context

系列收官变更（版本 `0.2.0-alpha.3`，规划 §6.3 blocks.ts + §3.1/3.2 图像事实）。修复 P0-2（图像静默丢弃）。依赖 add-model-facts（supportsImages/imageFormats/imageRequiresBase64）与 make-responses-default-wire-protocol（wire 分支上下文）。图像限制数值对照 /tmp/sn_docs_zh.md：6.8 :208-240（jpg/jpeg/png/webp，公网 URL 或 base64）、deepseek-flash :1468-1500（JPEG/PNG/GIF/WebP，单图 50MB/总 64MB/200 张/URL 总量 200MB）、kimi-k3 :2194-2236（七格式仅 base64，content 必须对象数组）、Responses :3210 段（input_image+input_text，png/jpeg/gif/webp，不支持视频与 input_file）。

## Goals / Non-Goals

- Goals：blocks.ts 双分支翻译；宿主 attachment 三函数复用；按模型能力分派；kimi-k3 URL 降级；限制校验。
- Non-Goals：视频块（宿主当前无 video 块类型，out of scope，spec 已声明）；input_file；不改 ModelFacts 字段定义（add-model-facts 所有）。

## Decisions

1. **复用宿主、禁止自造**：`contentHasImage`（检测）/`projectImagesForTextModel`（纯文本模型投影）/`offloadRequestImagesWithPolicy`（图像卸载策略）/`resolveImageAttachmentAccess`（attachment ref → 本地只读路径）全部经 dsh-llm re-export 引入；blocks.ts 只做「宿主块（attachment ref）→ wire 出站项」的形态翻译（见前提假设的数据流），不做图像处理本身。
2. **双分支形态**（硬约束）：chat=`{type:'image_url',image_url:{url}}`（嵌套）；responses=`{type:'input_image',image_url:<URL 或 dataURL>}`（**扁平字段**，与 chat 形态不同是常见踩坑点，测试断言两者形状）。文本项 responses 用 `input_text`。
3. **kimi-k3 URL 降级策略——选「文本占位提示」而非拒绝**：URL 图像无法直传（仅 base64），但拒绝会打断整次对话且多轮场景用户无感；选择在图像位置插入文本占位块（说明图像未随请求发送及原因），并在日志记录。理由：kimi-k3 是唯一受影响模型、宿主图像多为本地粘贴（天然 base64 路径不受影响）、公网 URL 场景占比低且占位提示保留了对话连续性。若实测发现占位导致答非所问率仍高，再升级为可配置拒绝。
4. **纯文本模型投影**：v4-flash/glm-5.2（文档无图像章节，supportsImages=false）走 `projectImagesForTextModel`，由宿主决定投影形态（通常为图片说明文本），插件不自行丢弃。
5. **限制校验出站前完成**：格式集按 imageFormats 校验；deepseek-flash 的 50MB/64MB/200张/200MB 数值在 blocks.ts 校验层声明；超限报错文案带数值。Responses 协议下格式集再与 png/jpeg/gif/webp 求交。
6. **文件落点**：`src/wire/blocks.ts`（规划 §6.3），chat/responses 两导出函数，供 body-chat.ts/body-responses.ts 调用。

## Risks / Trade-offs

- kimi-k3 占位策略可能造成「模型没看到图」的答非所问（决策 3 已论证取舍与升级路径）。
- 限制数值来自文档，目录若返回更严格实测值（未来 ModelFacts 扩展）需覆盖静态值——本变更先按文档值。

## 前提假设

（已按 task-13 升级事实更新，原「以升级后 0.1.7-rc.2 类型面为准、实现时核对」的假设已落实为下列数据流。）
- **ImageBlock 实际形状**：0.1.7-rc.2 的 ImageBlock 携带 `attachment: ImageAttachmentRef` + `offloaded?: true`，无内联 base64/URL 字段。数据流（design 决策 1 的展开）：图像来源 = attachment ref 解析（dsh-llm re-export 的 `resolveImageAttachmentAccess(ref, mapHostPath)` 给出本地只读路径）→ 读本地文件 → 按 wire 编码（URL 可直传的分支直传；需 base64 的分支读文件转 base64 data URL）。`offloaded?: true` 的块用宿主 `requestImageHandleText`/`offloadedImageText` 投影为文本占位，不进图像翻译路径。
- deepseek-flash 的 MB 级限制按 1024 进制处理（50MB=52,428,800 字节），实测若按 1000 进制再修正。

## Migration Plan

无配置迁移。用户可见变化：多模态模型粘图从「静默丢弃」变为「随请求发送」；纯文本模型从「静默丢弃」变为宿主投影形态。

## Open Questions

- kimi-k3 七格式的完整清单文档列举顺序与命名（jpg/jpeg 之类大小写别名映射）需实现时对照 :2194-2236 原表逐一核对。
- offloadRequestImagesWithPolicy 的策略参数在本插件场景的默认选择（实现时按宿主类型面定）。
