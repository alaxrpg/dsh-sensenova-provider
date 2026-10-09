# Delta Spec: add-multimodal-input

## ADDED Requirements

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
