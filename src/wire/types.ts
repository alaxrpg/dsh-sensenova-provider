/** 模型能力档案（add-model-facts；docs/sensenova-upgrade-plan.md §6.2）。
 *
 * 数据源：官方文档静态事实（/tmp/sn_docs_zh.md）+ /v1/models 目录实测值。
 * 优先级：目录实测值 > 静态档案（见 wire/facts.ts 的 factsFor）。
 * 本接口同时服务 Chat（task-3 字段分派）与后续 Responses wire（task-9/10）。 */

/** wire 协议标识（本期 chat-completions + responses）。 */
export type WireKind = 'chat-completions' | 'responses';

export interface ModelFacts {
  /** 模型 id（静态档案键；factsFor 结果回填请求模型 id）。 */
  id: string;
  /** 本模型可用的 wire 协议（目录不含该信息，纯静态）。 */
  supportedWires: readonly WireKind[];
  /** 推理档位 wire 原值（按文档参数表权威列）；空数组 = 未知/不支持声明。 */
  efforts: readonly string[];
  /** Chat 默认档（文档标注）；null = 未知。 */
  defaultEffort: string | null;
  /** Responses 默认档（§3.2：6.8/v4-flash/v4.1-flash=high，glm/kimi=max）；null = 未知。 */
  responsesDefaultEffort: string | null;
  /** 宿主档位 → wire 值的兼容映射（仅 deepseek-flash 文档声明）。 */
  effortCompat?: Readonly<Record<string, string>>;
  /** Chat 输出上限字段名：kimi-k3 用 max_completion_tokens，其余 max_tokens。 */
  outputLimitField: 'max_tokens' | 'max_completion_tokens';
  /** Chat 输出上限（目录 max_output_length 实测值优先覆盖）。 */
  outputLimitMax: number | null;
  /** Chat 流式显式 stream_options:{include_usage:true}（glm-5.2 false）。 */
  supportsStreamOptions: boolean;
  /** deepseek 系带 tools 时回放历史 reasoning_content。 */
  requiresReasoningReplay: boolean;
  /** 禁用 thinking:"disabled" 表达关思考（glm-5.2 传 disabled 直接失败）。 */
  forbidThinkingDisabled: boolean;
  /** kimi-k3 特例：effort none → thinking:"disabled"（文档自相矛盾，待实测修正）。 */
  noneMapsToThinkingDisabled: boolean;
  /** 固定 temperature（kimi-k3 = 1，传了也不变）；null = 可调。 */
  fixedTemperature: number | null;
  /** 固定 top_p（kimi-k3 = 0.95）；null = 可调。 */
  fixedTopP: number | null;
  /** 出站永不发送的采样字段（kimi-k3 频率/在场惩罚 + 固定采样）。 */
  blockedSampling: readonly string[];
  /** 静态采样参数白名单（目录 supported_sampling_parameters 优先覆盖）；
   * undefined = 无白名单（目录与静态均未声明，采样字段全放行）。 */
  samplingParameters?: readonly string[];
  /** 是否支持图像输入（目录 input_modalities 含 image 时覆盖为 true）。 */
  supportsImages: boolean;
  /** 支持的图像格式（小写扩展名族；仅 supportsImages 时有意义）。 */
  imageFormats: readonly string[];
  /** 仅接受 base64 data URL、不支持公网 URL（kimi-k3）。 */
  imageRequiresBase64: boolean;
  /** Responses max_output_tokens 上限（§3.2 范围表；deepseek-flash 文档未列 = null 待实测）。 */
  responsesMaxOutputTokens: number | null;
  /** Responses text.format.type 支持 json_schema（deepseek-flash/kimi-k3）。 */
  responsesSupportsJsonSchema: boolean;
}

/** factsFor 的目录侧输入（adapter 的 CatalogEntry 结构子集，避免循环依赖）。 */
export interface FactsCatalogEntry {
  id: string;
  inputModalities: readonly string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  supportedSamplingParameters?: readonly string[];
}
