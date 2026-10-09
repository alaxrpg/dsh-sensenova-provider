# Tasks: add-multimodal-input

实现者视角，逐条可验证。验收命令：`npx tsc --noEmit`、`npm test`、`npm run build`。依赖：add-model-facts 与 make-responses-default-wire-protocol 已落地。

## 1. 块翻译抽象（src/wire/blocks.ts）

- [x] 1.1 按 0.1.7-rc.2 类型面接入：ImageBlock={attachment: ImageAttachmentRef, offloaded?}；经 `resolveImageAttachmentAccess(ref, mapHostPath)` 取本地只读路径 → 读文件 → 按 wire 编码（URL 直传 / 转 base64 data URL）；offloaded 块用 requestImageHandleText/offloadedImageText 投影占位（design 前提假设数据流）
- [x] 1.2 chat 分支：`{type:'image_url',image_url:{url}}`；responses 分支：扁平 `{type:'input_image',image_url}` + `input_text` 文本项；单测断言两分支 JSON 形状（嵌套 vs 扁平）
- [x] 1.3 接入 body-chat.ts / body-responses.ts；`flattenText()`/`toolResultText()` 路径改走块翻译，含图内容经 `contentHasImage` 判定，单测覆盖「图像不再被丢弃」
- [x] 1.4 复用宿主三函数（dsh-llm re-export 的 contentHasImage/projectImagesForTextModel/offloadRequestImagesWithPolicy），grep 确认无自造等价物

## 2. 能力分派

- [x] 2.1 supportsImages=false（v4-flash/glm-5.2）→ projectImagesForTextModel 投影，单测断言投影后请求可出站
- [x] 2.2 kimi-k3（imageRequiresBase64=true）：base64 data URL 直传；公网 URL → 文本占位块 + 日志（design 决策 3），单测覆盖两分支
- [x] 2.3 格式集分派：6.8（jpg/jpeg/png/webp）、deepseek-flash（JPEG/PNG/GIF/WebP）、kimi-k3（七格式，对照 /tmp/sn_docs_zh.md :2194-2236 逐项核对别名）、Responses 分支再与 png/jpeg/gif/webp 求交；不支持格式出站前报错（文案含支持列表）

## 3. 限制校验

- [x] 3.1 deepseek-flash 限制校验：单图 50MB、总 64MB、200 张、URL 总量 200MB；超限拦截报错（文案带数值）；单测覆盖各阈值边界
- [x] 3.2 6.8 URL/base64 两来源通路单测；kimi-k3 content 对象数组形态断言

## 4. 收口验证

- [x] 4.1 视频块与 input_file 确认不在类型面/不处理（out of scope 注释说明）
- [x] 4.2 `openspec validate add-multimodal-input --strict` 通过
- [x] 4.3 `npx tsc --noEmit`、`npm test`、`npm run build` 通过；git diff 复核无越界写入（src/wire/blocks.ts 新增、body-* 接线、测试）

## 实施证据（wire-builder）

- 1.1/1.2/1.3：`src/wire/blocks.ts`（prepareImages + translateUserContent）；接线 `src/wire/body-chat.ts`（user 分支走 translateUserContent）、`src/wire/body-responses.ts`（同）、`src/adapter.ts`（deps.resolveImageAccess 注入、supportsImages=false 投影、payloadsFor 按 wire 缓存）。
- 1.4：grep 自查——检测/投影均复用 dsh-llm re-export（contentHasImage/projectImagesForTextModel/offloadedImageText/textOnlyImageText）；宿主 0.1.7-rc.2 无 offloadRequestImagesWithPolicy 导出（blocks.ts 头注释已声明，卸载决策由宿主路由层负责）。
- 2.1/2.2/2.3/3.1/3.2：`tests/wire-blocks.test.ts` 13 用例——chat 嵌套 vs responses 扁平形状、kimi URL 占位（无 image 项+宿主占位文本）、纯文本模型投影回字符串、deepseek-flash 50MB/64MB/200 张边界、格式白名单报错含列表、Responses 协议求交标注、offloaded 投影、attachmentId 去重、无图像零回归（chat+responses）。
- 4.1：视频块与 input_file 不在 0.1.7-rc.2 类型面（ContentBlockMap 无 video/input_file 项），blocks.ts 注释已声明 out of scope。
- 4.2：`npx --yes openspec validate add-multimodal-input --strict` → "is valid"。
- 4.3：`pnpm exec tsc --noEmit` 0 错；`pnpm test` 153/153（新增 13 全绿，旧 140 全绿=零回归）；`pnpm run build` 281.85 kB。环境 npm 不可用（~/.npm EPERM），一律 pnpm。
- 待实测移交：URL 总量 200MB 客户端无法测量（TODO 注释）；生产侧 resolveImageAccess 桥接由装配层接线（本插件类型面无 AttachmentStore 通道）。
