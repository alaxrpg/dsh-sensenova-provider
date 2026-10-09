import test from 'node:test';
import assert from 'node:assert/strict';
import { factsFor, staticFacts } from '../src/wire/facts.ts';
import type { FactsCatalogEntry, ModelFacts } from '../src/wire/types.ts';

const MODELS = [
  'sensenova-6.8-flash-lite',
  'deepseek-v4-flash',
  'deepseek-flash',
  'glm-5.2',
  'kimi-k3',
] as const;

/** 逐字段期望矩阵（数据源：/tmp/sn_docs_zh.md + docs/sensenova-upgrade-plan.md §3.1/§3.2）。 */
const EXPECTED: Record<string, Partial<ModelFacts> & { efforts: readonly string[]; defaultEffort: string }> = {
  'sensenova-6.8-flash-lite': {
    efforts: ['low', 'medium', 'high', 'max', 'none'], defaultEffort: 'high',
    responsesDefaultEffort: 'high', outputLimitField: 'max_tokens', outputLimitMax: 65536,
    supportsStreamOptions: true, requiresReasoningReplay: false,
    supportsImages: true, imageFormats: ['jpg', 'jpeg', 'png', 'webp'], imageRequiresBase64: false,
    responsesMaxOutputTokens: 65536, responsesSupportsJsonSchema: false,
  },
  'deepseek-v4-flash': {
    efforts: ['low', 'medium', 'high', 'max', 'none'], defaultEffort: 'high',
    responsesDefaultEffort: 'high', outputLimitField: 'max_tokens', outputLimitMax: 384000,
    supportsStreamOptions: true, requiresReasoningReplay: true,
    supportsImages: false, imageFormats: [], imageRequiresBase64: false,
    responsesMaxOutputTokens: 384000, responsesSupportsJsonSchema: false,
  },
  'deepseek-flash': {
    efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high',
    responsesDefaultEffort: 'high', outputLimitField: 'max_tokens', outputLimitMax: 393216,
    supportsStreamOptions: true, requiresReasoningReplay: true,
    effortCompat: { minimal: 'low', medium: 'high', xhigh: 'high', ultra: 'max' },
    supportsImages: true, imageFormats: ['jpeg', 'png', 'gif', 'webp'], imageRequiresBase64: false,
    responsesMaxOutputTokens: null, responsesSupportsJsonSchema: true,
  },
  'glm-5.2': {
    efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'], defaultEffort: 'max',
    responsesDefaultEffort: 'max', outputLimitField: 'max_tokens', outputLimitMax: 131072,
    supportsStreamOptions: false, requiresReasoningReplay: false, forbidThinkingDisabled: true,
    supportsImages: false, imageFormats: [], imageRequiresBase64: false,
    responsesMaxOutputTokens: 131072, responsesSupportsJsonSchema: false,
  },
  'kimi-k3': {
    efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'max',
    responsesDefaultEffort: 'max', outputLimitField: 'max_completion_tokens', outputLimitMax: 1048576,
    supportsStreamOptions: true, requiresReasoningReplay: false,
    fixedTemperature: 1, fixedTopP: 0.95,
    blockedSampling: ['frequency_penalty', 'presence_penalty', 'temperature', 'top_p'],
    supportsImages: true,
    imageFormats: ['jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif'],
    imageRequiresBase64: true,
    responsesMaxOutputTokens: 1048576, responsesSupportsJsonSchema: true,
  },
};

test('facts: 五模型静态档案字段完整且与文档矩阵逐项相等（1.1/1.2/1.3）', () => {
  for (const model of MODELS) {
    const facts = staticFacts(model);
    assert.ok(facts, `${model} 应有静态档案`);
    assert.equal(facts.id, model);
    assert.deepEqual(facts.supportedWires, ['chat-completions', 'responses'], `${model} Responses 支持集`);
    const expected = EXPECTED[model];
    for (const [key, value] of Object.entries(expected)) {
      const k = key as keyof ModelFacts;
      if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
        assert.deepEqual(facts[k], value, `${model}.${key}`);
      } else {
        assert.equal(facts[k], value, `${model}.${key}`);
      }
    }
  }
  assert.deepEqual(staticFacts('kimi-k3')?.samplingParameters, ['seed', 'parallel_tool_calls'], 'kimi 静态采样兜底（task-8 ①）');
  assert.deepEqual(staticFacts('sensenova-6.8-flash-lite')?.samplingParameters, ['seed', 'n', 'parallel_tool_calls']);
  assert.equal(staticFacts('sensenova-6.8-flash-lite')?.noneMapsToThinkingDisabled, false);
  assert.equal(staticFacts('kimi-k3')?.noneMapsToThinkingDisabled, true);
});

test('facts: deepseek-v4-pro 不收录；未收录 id 返回通用兜底不抛错（1.2/1.3）', () => {
  assert.equal(staticFacts('deepseek-v4-pro'), undefined);
  const generic = factsFor('totally-unknown-model', undefined);
  assert.equal(generic.id, 'totally-unknown-model');
  assert.deepEqual(generic.supportedWires, ['chat-completions']);
  assert.deepEqual(generic.efforts, []);
  assert.equal(generic.defaultEffort, null);
  assert.equal(generic.supportsStreamOptions, false);
  assert.equal(generic.outputLimitMax, null);
  assert.equal(generic.samplingParameters, undefined);
});

test('factsFor: 目录实测值覆盖静态值（2.1 覆盖分支）', () => {
  const entry: FactsCatalogEntry = {
    id: 'glm-5.2',
    inputModalities: ['text', 'image'],
    contextWindow: 262144,
    maxOutputTokens: 9999,
    supportedSamplingParameters: ['temperature'],
  };
  const facts = factsFor('glm-5.2', entry);
  assert.equal(facts.outputLimitMax, 9999, '目录 max_output_length 覆盖静态');
  assert.deepEqual(facts.samplingParameters, ['temperature'], '目录采样白名单覆盖静态');
  assert.equal(facts.supportsImages, true, '目录 input_modalities 含 image 开图像');
  assert.deepEqual(facts.imageFormats, ['jpeg', 'png', 'webp', 'gif'], '静态空格式时用通用格式集');
  // 未覆盖项保持静态
  assert.deepEqual(facts.efforts, EXPECTED['glm-5.2'].efforts);
  assert.equal(facts.defaultEffort, 'max');
});

test('factsFor: 目录缺失字段回退静态（2.1 回退分支）', () => {
  const entry: FactsCatalogEntry = { id: 'kimi-k3', inputModalities: ['text'] };
  const facts = factsFor('kimi-k3', entry);
  assert.equal(facts.outputLimitMax, 1048576);
  assert.equal(facts.supportsImages, false, '目录声明不含 image 时覆盖关闭');
  assert.deepEqual(facts.imageFormats, []);
  assert.deepEqual(facts.samplingParameters, ['seed', 'parallel_tool_calls'], '回退静态采样兜底');
  // 已开图像的静态模型被目录 text-only 实测关闭
  const ds = factsFor('deepseek-flash', { id: 'deepseek-flash', inputModalities: ['text'] });
  assert.equal(ds.supportsImages, false);
});

test('factsFor: 目录缺该模型条目时（undefined）全静态（2.1）', () => {
  const facts = factsFor('deepseek-flash', undefined);
  assert.equal(facts.outputLimitMax, 393216);
  assert.equal(facts.responsesMaxOutputTokens, null, 'deepseek-flash Responses 上限待实测');
  assert.equal(facts.supportsImages, true);
});

test('factsFor: 未知模型 + 目录仍能补上限与白名单（宽容忽略未知字段）', () => {
  const facts = factsFor('mystery-model', {
    id: 'mystery-model',
    inputModalities: ['text'],
    maxOutputTokens: 4096,
    supportedSamplingParameters: ['temperature', 'stop'],
  });
  assert.equal(facts.outputLimitMax, 4096);
  assert.deepEqual(facts.samplingParameters, ['temperature', 'stop']);
  assert.deepEqual(facts.efforts, []);
});
