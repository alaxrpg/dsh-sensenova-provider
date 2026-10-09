/** 静态模型能力档案 + 目录合并（add-model-facts tasks 1.1–2.1）。
 *
 * 数值与 align-request-fields-with-docs 落地后的 KNOWN_EFFORTS/KNOWN_SAMPLING_PARAMS
 * 同源（原文 /tmp/sn_docs_zh.md；Chat 出站行为零变化，见 adapter.ts 消费注释）。 */
import type { FactsCatalogEntry, ModelFacts } from './types.ts';

/** 未收录模型 id 的通用兜底档案（不抛错；Chat 行为与迁移前「未知模型」路径一致）。 */
const GENERIC_FACTS: ModelFacts = {
  id: '',
  supportedWires: ['chat-completions'],
  efforts: [],
  defaultEffort: null,
  responsesDefaultEffort: null,
  outputLimitField: 'max_tokens',
  outputLimitMax: null,
  supportsStreamOptions: false, // 未知模型保守不发 stream_options（迁移前同）
  requiresReasoningReplay: false,
  forbidThinkingDisabled: false,
  noneMapsToThinkingDisabled: false,
  fixedTemperature: null,
  fixedTopP: null,
  blockedSampling: [],
  supportsImages: false,
  imageFormats: [],
  imageRequiresBase64: false,
  responsesMaxOutputTokens: null,
  responsesSupportsJsonSchema: false,
};

/** 静态档案表（deepseek-v4-pro 已下线，不收录）。
 * 行号锚点：6.8 参数表 :543-560；v4-flash :1288-1320；deepseek-flash :1665-1673；
 * glm-5.2 :2022 起；kimi-k3 :2403-2451；Responses §3.2（升级计划 docs/sensenova-upgrade-plan.md:111-114）。 */
const STATIC_FACTS: ReadonlyMap<string, ModelFacts> = new Map([
  ['sensenova-6.8-flash-lite', {
    id: 'sensenova-6.8-flash-lite',
    supportedWires: ['chat-completions', 'responses'],
    efforts: ['low', 'medium', 'high', 'max', 'none'],
    defaultEffort: 'high',
    responsesDefaultEffort: 'high',
    outputLimitField: 'max_tokens',
    outputLimitMax: 65536,
    supportsStreamOptions: true,
    requiresReasoningReplay: false,
    forbidThinkingDisabled: false,
    noneMapsToThinkingDisabled: false,
    fixedTemperature: null,
    fixedTopP: null,
    blockedSampling: [],
    samplingParameters: ['seed', 'n', 'parallel_tool_calls'],
    supportsImages: true,
    imageFormats: ['jpg', 'jpeg', 'png', 'webp'],
    imageRequiresBase64: false,
    responsesMaxOutputTokens: 65536,
    responsesSupportsJsonSchema: false,
  }],
  ['deepseek-v4-flash', {
    id: 'deepseek-v4-flash',
    supportedWires: ['chat-completions', 'responses'],
    efforts: ['low', 'medium', 'high', 'max', 'none'],
    defaultEffort: 'high',
    responsesDefaultEffort: 'high',
    outputLimitField: 'max_tokens',
    outputLimitMax: 384000,
    supportsStreamOptions: true,
    requiresReasoningReplay: true,
    forbidThinkingDisabled: false,
    noneMapsToThinkingDisabled: false,
    fixedTemperature: null,
    fixedTopP: null,
    blockedSampling: [],
    supportsImages: false,
    imageFormats: [],
    imageRequiresBase64: false,
    responsesMaxOutputTokens: 384000,
    responsesSupportsJsonSchema: false,
  }],
  ['deepseek-flash', {
    // V4.1 Flash：原生档 none/low/high/max + 兼容映射；Responses 上限文档未列（待实测）。
    id: 'deepseek-flash',
    supportedWires: ['chat-completions', 'responses'],
    efforts: ['none', 'low', 'high', 'max'],
    defaultEffort: 'high',
    responsesDefaultEffort: 'high',
    effortCompat: { minimal: 'low', medium: 'high', xhigh: 'high', ultra: 'max' },
    outputLimitField: 'max_tokens',
    outputLimitMax: 393216,
    supportsStreamOptions: true,
    requiresReasoningReplay: true,
    forbidThinkingDisabled: false,
    noneMapsToThinkingDisabled: false,
    fixedTemperature: null,
    fixedTopP: null,
    blockedSampling: [],
    supportsImages: true,
    imageFormats: ['jpeg', 'png', 'gif', 'webp'],
    imageRequiresBase64: false,
    responsesMaxOutputTokens: null, // §3.2 范围表漏列 deepseek-flash，须实测
    responsesSupportsJsonSchema: true,
  }],
  ['glm-5.2', {
    id: 'glm-5.2',
    supportedWires: ['chat-completions', 'responses'],
    efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'],
    defaultEffort: 'max',
    responsesDefaultEffort: 'max',
    outputLimitField: 'max_tokens',
    outputLimitMax: 131072,
    supportsStreamOptions: false,
    requiresReasoningReplay: false,
    forbidThinkingDisabled: true,
    noneMapsToThinkingDisabled: false,
    fixedTemperature: null,
    fixedTopP: null,
    blockedSampling: [],
    supportsImages: false,
    imageFormats: [],
    imageRequiresBase64: false,
    responsesMaxOutputTokens: 131072,
    responsesSupportsJsonSchema: false,
  }],
  ['kimi-k3', {
    id: 'kimi-k3',
    supportedWires: ['chat-completions', 'responses'],
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'max',
    responsesDefaultEffort: 'max',
    outputLimitField: 'max_completion_tokens',
    outputLimitMax: 1048576, // 1M−prompt 软上限
    supportsStreamOptions: true,
    requiresReasoningReplay: false,
    forbidThinkingDisabled: false,
    noneMapsToThinkingDisabled: true, // 文档自相矛盾，按 thinking 可关落地（待实测修正）
    fixedTemperature: 1,
    fixedTopP: 0.95,
    blockedSampling: ['frequency_penalty', 'presence_penalty', 'temperature', 'top_p'],
    samplingParameters: ['seed', 'parallel_tool_calls'],
    supportsImages: true,
    imageFormats: ['jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif'],
    imageRequiresBase64: true, // 不支持公网 URL，仅 base64
    responsesMaxOutputTokens: 1048576,
    responsesSupportsJsonSchema: true,
  }],
]);

/** 静态档案查询（未收录返回 undefined；adapter 的目录解析路径使用）。 */
export function staticFacts(model: string): ModelFacts | undefined {
  return STATIC_FACTS.get(model);
}

/** 目录实测值 > 静态档案：context/max_output/input_modalities/supported_sampling_parameters
 * 覆盖静态对应项，缺失回退静态；未知目录字段宽容忽略；未收录模型返回通用兜底（不抛错）。 */
export function factsFor(model: string, entry: FactsCatalogEntry | undefined): ModelFacts {
  const base = STATIC_FACTS.get(model);
  if (base === undefined) {
    // 未知模型：目录能补的只有输出上限与采样白名单（与迁移前未知模型路径一致）。
    return {
      ...GENERIC_FACTS,
      id: model,
      outputLimitMax: entry?.maxOutputTokens ?? null,
      ...(entry?.supportedSamplingParameters !== undefined
        ? { samplingParameters: entry.supportedSamplingParameters }
        : {}),
    };
  }
  const outputLimitMax = entry?.maxOutputTokens ?? base.outputLimitMax;
  // input_modalities 实测覆盖：目录声明含 image 才开图像；静态格式非空沿用，否则用通用格式集。
  const catalogDeclaresImage = entry?.inputModalities.includes('image') ?? base.supportsImages;
  const supportsImages = catalogDeclaresImage;
  const imageFormats = supportsImages
    ? (base.imageFormats.length > 0 ? base.imageFormats : ['jpeg', 'png', 'webp', 'gif'])
    : [];
  return {
    ...base,
    outputLimitMax,
    supportsImages,
    imageFormats,
    ...(entry?.supportedSamplingParameters !== undefined
      ? { samplingParameters: entry.supportedSamplingParameters }
      : {}),
  };
}
