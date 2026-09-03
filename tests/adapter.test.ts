import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SensenovaAdapter, type SensenovaConnection } from '../src/adapter.ts';
import { resolveAdapterOptions } from '../src/index.ts';

const CONNECTION: SensenovaConnection = { apiBase: 'https://example.invalid', accountCount: 2 };

function sseResponse(sseText: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseText));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 用固定目录响应构造适配器；models 端点返回给定 data 数组。 */
function catalogAdapter(data: unknown[], modelSelection?: SensenovaConnection['modelSelection']): SensenovaAdapter {
  const body = JSON.stringify({ data });
  const connection: SensenovaConnection = { ...CONNECTION, ...(modelSelection !== undefined ? { modelSelection } : {}) };
  return new SensenovaAdapter({
    options: () => connection,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
}

/** 用可编程 chat 端点构造适配器（用于 404/429 断言）。 */
function chatAdapter(handler: (call: number) => Response | Promise<Response>): {
  adapter: SensenovaAdapter;
  calls: () => number;
  rotateCalls: Array<{ rejected: string; rejection: string; retryAfterMs?: number }>;
} {
  let calls = 0;
  const rotateCalls: Array<{ rejected: string; rejection: string; retryAfterMs?: number }> = [];
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection, retryAfterMs) => {
      rotateCalls.push({ rejected, rejection, retryAfterMs });
      return 'key-2';
    },
    fetchImpl: (async () => {
      calls += 1;
      return handler(calls);
    }) as typeof fetch,
  });
  return { adapter, calls: () => calls, rotateCalls };
}

const FIXED_SSE = [
  'data: {"id":"1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const OPTIONS: GenerateOptions = {
  provider: 'sensenova',
  model: 'test-model',
  messages: [],
};

async function collect(adapter: SensenovaAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

test('stream: 把 OpenAI SSE 翻译为 block-start/text-delta/block-end/usage/finish', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => sseResponse(FIXED_SSE)) as typeof fetch,
  });

  const chunks = await collect(adapter, OPTIONS);

  assert.deepEqual(chunks.map((c) => c.type), [
    'block-start',
    'text-delta',
    'text-delta',
    'block-end',
    'usage',
    'finish',
  ]);

  const start = chunks[0];
  assert.ok(start && start.type === 'block-start');
  assert.equal(start.blockType, 'text');

  const delta1 = chunks[1];
  const delta2 = chunks[2];
  assert.ok(delta1 && delta1.type === 'text-delta');
  assert.ok(delta2 && delta2.type === 'text-delta');
  assert.equal(delta1.text + delta2.text, 'Hello world');

  const end = chunks[3];
  assert.ok(end && end.type === 'block-end');
  assert.ok(end.block.type === 'text');
  assert.equal(end.block.text, 'Hello world');

  const usage = chunks[4];
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.usage.inputTokens, 10);
  assert.equal(usage.usage.outputTokens, 5);
  assert.equal(usage.usage.totalTokens, 15);

  const finish = chunks[5];
  assert.ok(finish && finish.type === 'finish');
  assert.deepEqual(finish.reason, { kind: 'stop' });
});

test('stream: finish 后 trailing usage-only SSE 不丢 usage 且不重复 finish', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null]}]',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: {"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  const usage = chunks.find((chunk) => chunk.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.usage.totalTokens, 6);
});

test('stream: usage-before-finish 在 finish 时发出且仅发出一次', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.equal(chunks.filter((chunk) => chunk.type === 'usage').length, 1);
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  const usage = chunks.find((chunk) => chunk.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.usage.totalTokens, 4);
});

test('stream: 同一 SSE 事件多个 choices finish 只输出一个 finish', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"},{"delta":{"content":"ignored"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  const text = chunks.find((chunk) => chunk.type === 'text-delta');
  assert.ok(text && text.type === 'text-delta');
  assert.equal(text.text, 'ok');
});

test('stream: 429 不轮换 key，直接抛 RATE_LIMIT 交宿主退避重试', async () => {
  let calls = 0;
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      return 'key-2';
    },
    fetchImpl: (async () => {
      calls += 1;
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
    }) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    // 30s 超过 3000ms 上限，不透传 providerRetryAfterMs，交宿主本地退避。
    assert.equal(e.failure.providerRetryAfterMs, undefined);
    return true;
  });
  assert.equal(calls, 1, '只请求一次，不换 key 重试（保护 prompt 缓存）');
  assert.equal(rotateCalls.length, 0, '429 不触发账号轮换/冷却');
});

test('stream: 401 全部失败抛 INVALID_CREDENTIAL', async () => {
  let rotateCount = 0;
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => {
      rotateCount += 1;
      return rotateCount === 1 ? 'key-2' : undefined;
    },
    fetchImpl: (async () => new Response('unauthorized', { status: 401 })) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    return (err as LlmError).code === 'INVALID_CREDENTIAL';
  });
});

test('listModels: 过滤文生图模型与已知 stale 模型，保留文本模型', async () => {
  const adapter = catalogAdapter([
    { id: 'sensenova-6.8-flash-lite', output_modalities: ['text'], input_modalities: ['text'] },
    { id: 'sensenova-u1-fast', output_modalities: ['image'], input_modalities: ['text'] },
    { id: 'sensenova-u1.5-lite', output_modalities: ['image'] },
    { id: 'sensenova-6.7-flash-lite', output_modalities: ['text'], input_modalities: ['text'] },
    { id: 'sensenova-6.8-pro', output_modalities: ['text', 'image'], input_modalities: ['text', 'image'] },
  ]);

  const models = await adapter.listModels('sensenova');
  const ids = models.map((m) => m.id).sort();

  assert.deepEqual(ids, ['sensenova-6.8-flash-lite', 'sensenova-6.8-pro']);
});

test('listModels: 手动 include 可恢复 stale，但 exclude 优先且 image-only 永远排除', async () => {
  const adapter = catalogAdapter([
    { id: 'sensenova-6.7-flash-lite', output_modalities: ['text'], input_modalities: ['text'], context_length: 65536 },
    { id: 'sensenova-u1-fast', output_modalities: ['image'], input_modalities: ['text'] },
    { id: 'sensenova-ok', output_modalities: ['text'], input_modalities: ['text'] },
  ], {
    include: [' sensenova-6.7-flash-lite ', 'sensenova-u1-fast', 'unknown-id'],
    exclude: ['sensenova-ok', 'sensenova-6.7-flash-lite'],
  });
  const models = await adapter.listModels('sensenova');
  assert.deepEqual(models.map((model) => model.id), []);

  const restored = catalogAdapter([
    { id: 'sensenova-6.7-flash-lite', output_modalities: ['text'], input_modalities: ['text'], context_length: 65536 },
    { id: 'sensenova-u1-fast', output_modalities: ['image'] },
  ], { include: ['sensenova-6.7-flash-lite', 'sensenova-u1-fast'] });
  const restoredModels = await restored.listModels('sensenova');
  assert.deepEqual(restoredModels.map((model) => model.id), ['sensenova-6.7-flash-lite']);
  const resolved = await restored.resolveModel('sensenova', 'sensenova-6.7-flash-lite');
  assert.equal(resolved.context?.contextWindow, 65536);
});

test('listModels: 未出现在最新目录中的手动 include 不合成条目，刷新继续应用配置', async () => {
  let phase = 0;
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, modelSelection: { include: ['sensenova-stale'], exclude: [] } }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => {
      phase += 1;
      const data = phase === 1
        ? [{ id: 'sensenova-stale', output_modalities: ['text'], context_length: 123 }]
        : [{ id: 'sensenova-ok', output_modalities: ['text'], context_length: 456 }];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual((await adapter.listModels('sensenova')).map((model) => model.id), ['sensenova-stale']);
  assert.deepEqual((await adapter.listModels('sensenova')).map((model) => model.id), ['sensenova-ok']);
});

test('resolveAdapterOptions: 非法 credential-ref 不保留原文且不作为字面 key', () => {
  const resolved = resolveAdapterOptions({
    apiKeyEnv: 'invalid credential input',
    accounts: [{ id: 'extra', label: 'Extra', apiKeyEnv: 'not-a-credential-ref' }],
  });
  assert.equal(resolved.accounts[0]?.isLiteral, false);
  assert.equal(resolved.accounts[0]?.ref, '');
  assert.equal(resolved.accounts[1]?.isLiteral, false);
  assert.equal(resolved.accounts[1]?.ref, '');

  const valid = resolveAdapterOptions({ apiKeyEnv: 'SENSENOVA_API_KEY' });
  assert.equal(valid.accounts[0]?.isLiteral, false);
  assert.equal(valid.accounts[0]?.ref, 'SENSENOVA_API_KEY');
});

test('resolveAdapterOptions: concurrency 缺省 1，非正整数回退 1', () => {
  assert.equal(resolveAdapterOptions({}).concurrency, 1);
  assert.equal(resolveAdapterOptions({ concurrency: 3 }).concurrency, 3);
  assert.equal(resolveAdapterOptions({ concurrency: 0 }).concurrency, 1);
  assert.equal(resolveAdapterOptions({ concurrency: -1 }).concurrency, 1);
  assert.equal(resolveAdapterOptions({ concurrency: 2.5 }).concurrency, 1);
});

test('listModels: 无 key 时返回空目录不阻塞', async () => { 
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => {
      throw new LlmError('no key', 'MISSING_CREDENTIAL');
    },
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
  });
  assert.deepEqual(await adapter.listModels('sensenova'), []);
});

test('listModels/resolveModel: 多模态 input_modalities 与上下文/最大输出', async () => {
  const adapter = catalogAdapter([
    {
      id: 'sensenova-6.8-pro',
      output_modalities: ['text'],
      input_modalities: ['text', 'image'],
      context_length: 262144,
      max_output_tokens: 8192,
    },
  ]);
  await adapter.listModels('sensenova');

  const info = await adapter.resolveModel('sensenova', 'sensenova-6.8-pro');
  assert.deepEqual(info.inputModalities, ['text', 'image']);
  assert.equal(info.context?.contextWindow, 262144);
  assert.equal(info.defaultMaxTokens, 8192);
});

test('resolveModel: reasoning 词表映射为 ReasoningEffortId 与默认级别', async () => {
  const adapter = catalogAdapter([
    {
      id: 'sensenova-6.8-pro',
      output_modalities: ['text'],
      input_modalities: ['text'],
      reasoning_efforts: ['low', 'medium', 'high'],
      default_reasoning_effort: 'medium',
    },
  ]);
  await adapter.listModels('sensenova');

  const info = await adapter.resolveModel('sensenova', 'sensenova-6.8-pro');
  const reasoning = info.reasoning;
  assert.ok(reasoning);
  assert.deepEqual(reasoning.efforts.map((e) => e.id), ['low', 'medium', 'high']);
  assert.equal(reasoning.defaultEffort, 'medium');
  assert.equal(reasoning.efforts[0]?.name, 'low');
});

test('resolveModel: 仅支持标记不虚构 reasoning 级别', async () => {
  const adapter = catalogAdapter([
    {
      id: 'sensenova-6.8-pro',
      output_modalities: ['text'],
      input_modalities: ['text'],
      supported_parameters: ['reasoning_effort'],
      thinking: true,
    },
  ]);
  await adapter.listModels('sensenova');

  const info = await adapter.resolveModel('sensenova', 'sensenova-6.8-pro');
  assert.equal(info.reasoning, undefined);
});

test('resolveModel: 嵌套 reasoning.efforts 词表与目录刷新后能力同步', async () => {
  const adapter = catalogAdapter([
    {
      id: 'sensenova-6.8-pro',
      output_modalities: ['text'],
      input_modalities: ['text'],
      context_window: 65536,
      reasoning: { efforts: ['low', 'high'], default_effort: 'high' },
    },
  ]);
  await adapter.listModels('sensenova');
  let info = await adapter.resolveModel('sensenova', 'sensenova-6.8-pro');
  assert.equal(info.context?.contextWindow, 65536);
  assert.deepEqual(info.reasoning?.efforts.map((e) => e.id), ['low', 'high']);
  assert.equal(info.reasoning?.defaultEffort, 'high');

  // 目录刷新后 context 变化，resolveModel 使用最新值。
  const refreshed = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => new Response(JSON.stringify({
      data: [{
        id: 'sensenova-6.8-pro',
        output_modalities: ['text'],
        input_modalities: ['text'],
        context_length: 131072,
        reasoning: { efforts: ['low'] },
      }],
    }), { status: 200 })) as typeof fetch,
  });
  await refreshed.listModels('sensenova');
  info = await refreshed.resolveModel('sensenova', 'sensenova-6.8-pro');
  assert.equal(info.context?.contextWindow, 131072);
  assert.deepEqual(info.reasoning?.efforts.map((e) => e.id), ['low']);
  assert.equal(info.reasoning?.defaultEffort, undefined);
});

test('listModels: 显示名标准化（flash-lite 显式映射 + 回退规则）', async () => {
  const adapter = catalogAdapter([
    { id: 'sensenova-6.7-flash-lite', output_modalities: ['text'], input_modalities: ['text'] },
    { id: 'sensenova-6.8-flash-lite', output_modalities: ['text'], input_modalities: ['text'] },
  ]);
  // 已知 stale 模型会被过滤，单独断言显式映射通过 resolveModel 兜底路径。
  const known = await adapter.resolveModel('sensenova', 'sensenova-6.7-flash-lite');
  assert.equal(known.name, 'Sensenova 6.7 Flash Lite');

  const models = await adapter.listModels('sensenova');
  const byId = new Map(models.map((m) => [m.id, m.name]));
  assert.equal(byId.get('sensenova-6.8-flash-lite'), 'Sensenova 6.8 Flash Lite');
});

test('providerRetryPolicy: normal / maxRetries=1000 / maxDelayMs=3000', () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
  });
  const policy = adapter.providerRetryPolicy('sensenova');
  assert.ok(policy);
  assert.equal(policy.mode, 'normal');
  if (policy.mode === 'normal') {
    assert.equal(policy.maxRetries, 1000);
    assert.equal(policy.maxDelayMs, 3000);
    assert.equal(policy.initialDelayMs, 500);
    // 保留默认 jitterRatio；宿主 localDelay 用 Math.min(..., maxDelayMs) 封顶，
    // 故初始延迟（含最大 jitter 1.1 倍）仍在 3000ms 上限内。
    assert.ok(policy.jitterRatio >= 0 && policy.jitterRatio <= 1);
    assert.ok(policy.initialDelayMs <= policy.maxDelayMs);
    assert.ok(policy.initialDelayMs * (1 + policy.jitterRatio) <= policy.maxDelayMs);
    assert.ok(policy.retryableCodes.includes('RATE_LIMIT'));
  }
});

test('stream: 404 model route not found → MODEL_NOT_FOUND 且不轮换', async () => {
  const { adapter, calls, rotateCalls } = chatAdapter(() =>
    new Response(JSON.stringify({ error: { message: 'model route not found' } }), { status: 404 }),
  );
  const options: GenerateOptions = { provider: 'sensenova', model: 'sensenova-6.7-flash-lite', messages: [] };

  await assert.rejects(collect(adapter, options), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'MODEL_NOT_FOUND');
    assert.equal(e.failure.status, 404);
    return true;
  });
  assert.equal(calls(), 1);
  assert.equal(rotateCalls.length, 0);
});

test('stream: 404 model is not found → MODEL_NOT_FOUND', async () => {
  const { adapter } = chatAdapter(() =>
    new Response(JSON.stringify({ error: { message: 'model is not found' } }), { status: 404 }),
  );
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    return (err as LlmError).code === 'MODEL_NOT_FOUND';
  });
});

test('stream: 非模型 404 保持通用 PROVIDER_HTTP_ERROR', async () => {
  const { adapter } = chatAdapter(() => new Response('not found', { status: 404 }));
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    return (err as LlmError).code === 'PROVIDER_HTTP_ERROR';
  });
});

test('stream: 运行时 404 失败模型写入失败缓存，后续 listModels 剔除', async () => {
  const data = [
    { id: 'sensenova-stale', output_modalities: ['text'], input_modalities: ['text'] },
    { id: 'sensenova-ok', output_modalities: ['text'], input_modalities: ['text'] },
  ];
  let phase = 0;
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/models')) {
        return new Response(JSON.stringify({ data }), { status: 200 });
      }
      // chat 端点：sensenova-stale 返回 404 模型不可路由。
      if (u.endsWith('/chat/completions')) {
        phase += 1;
        return new Response(JSON.stringify({ error: { message: 'model route not found' } }), { status: 404 });
      }
      return new Response('', { status: 500 });
    }) as typeof fetch,
  });

  const before = await adapter.listModels('sensenova');
  assert.ok(before.some((m) => m.id === 'sensenova-stale'));

  const options: GenerateOptions = { provider: 'sensenova', model: 'sensenova-stale', messages: [] };
  await assert.rejects(collect(adapter, options), (err: unknown) => (err as LlmError).code === 'MODEL_NOT_FOUND');

  const after = await adapter.listModels('sensenova');
  assert.ok(!after.some((m) => m.id === 'sensenova-stale'));
  assert.ok(after.some((m) => m.id === 'sensenova-ok'));
});

test('stream: 429 Retry-After 超过 3000ms 不透传 providerRetryAfterMs，且不轮换不冷却', async () => {
  const { adapter, calls, rotateCalls } = chatAdapter(() =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': '900' } }),
  );

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    // 超长 Retry-After 整值不透传（不截断为 3000）。
    assert.equal(e.failure.providerRetryAfterMs, undefined);
    return true;
  });
  // 429 不轮换、不冷却：单次请求单次调用，账号状态不变。
  assert.equal(calls(), 1);
  assert.equal(rotateCalls.length, 0);
});

test('stream: 429 Retry-After 在 3000ms 内透传 providerRetryAfterMs', async () => {
  const { adapter } = chatAdapter(() =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }),
  );
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    assert.equal(e.failure.providerRetryAfterMs, 2000);
    return true;
  });
});

test('stream: 历史中的空 tool_call（name/arguments/id 为空）被清洗，不再回放坏结构', async () => {
  let requestBody: unknown;
  // 用捕获 body 的适配器重放坏历史
  const captureAdapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async (_init: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });
  const options: GenerateOptions = {
    provider: 'sensenova',
    model: 'test-model',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          // 1) name 为空的失败 tool_call（本轮 400 根因）
          { type: 'tool-call', id: '', name: '', arguments: '' },
          // 2) 合法调用但 arguments 为空串、id 为空
          { type: 'tool-call', id: '', name: 'bash', arguments: '' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolCallId: '', content: [{ type: 'text', text: 'Error: invalid arguments' }] },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] as unknown as GenerateOptions['messages'],
  };
  await collect(captureAdapter, options);

  const body = requestBody as { messages: Array<Record<string, unknown>> };
  const assistant = body.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)) as Record<string, unknown>;
  assert.ok(assistant, '应保留含合法 tool_call 的 assistant 消息');
  const calls = assistant.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
  assert.equal(calls.length, 1, '空 name 的 tool_call 被丢弃');
  assert.equal(calls[0]?.function.name, 'bash');
  assert.equal(calls[0]?.function.arguments, '{}', '空 arguments 补为 {}');
  assert.match(calls[0]?.id ?? '', /^sensenova-sanitized-/, '空 id 合成稳定 id');
  const toolMsgs = body.messages.filter((m) => m.role === 'tool');
  // 空 toolCallId 的 result 映射到合成 id（两个空 id call 共享 ''，最后一个合法调用占据映射）
  assert.equal(toolMsgs.length, 1);
  assert.equal((toolMsgs[0] as { tool_call_id: string }).tool_call_id, calls[0]?.id);
});

test('stream: SSE 中 name 始终未到达的残缺 tool_call 不产出 block-end', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"tc1","function":{"arguments":"{\\"a\\":1}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const { adapter } = chatAdapter(() => sseResponse(sse));
  const chunks = await collect(adapter, OPTIONS);
  assert.equal(chunks.filter((c) => c.type === 'block-end').length, 0, '无 name 的工具调用不产出 tool-call block');
  assert.equal(chunks.at(-1)?.type, 'finish');
});

// ---- fix-sensenova-reasoning-ui-toolcalls 新增用例 ----

import { BlockAssembler } from '@deepseek-ai/dsh-llm';

/** 把 adapter 输出的 chunk 流经宿主 BlockAssembler 组装，返回最终块列表。 */
async function assembleBlocks(adapter: SensenovaAdapter, options: GenerateOptions): Promise<import('@deepseek-ai/dsh-llm').ContentBlock[]> {
  const assembler = new BlockAssembler();
  for await (const chunk of adapter.stream(options)) assembler.push(chunk);
  return assembler.blocks();
}

test('resolveModel: supported_features 含 reasoning + 静态表命中 → 暴露档位且无 defaultEffort', async () => {
  const adapter = catalogAdapter([
    { id: 'deepseek-v4-flash', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['tools', 'json_mode', 'reasoning'] },
  ]);
  await adapter.listModels('sensenova');
  const info = await adapter.resolveModel('sensenova', 'deepseek-v4-flash');
  const reasoning = info.reasoning;
  assert.ok(reasoning, '静态表命中的 reasoning 模型应暴露档位');
  assert.deepEqual(reasoning.efforts.map((e) => e.id), ['low', 'medium', 'high', 'none']);
  assert.equal(reasoning.efforts[0]?.name, 'low');
  assert.equal(reasoning.defaultEffort, undefined, '静态表不设 defaultEffort，保持网关默认');
});

test('resolveModel: 命中静态表但目录无 reasoning 标记 → 不暴露档位', async () => {
  const adapter = catalogAdapter([
    { id: 'deepseek-v4-flash', output_modalities: ['text'], input_modalities: ['text'] },
  ]);
  await adapter.listModels('sensenova');
  const info = await adapter.resolveModel('sensenova', 'deepseek-v4-flash');
  assert.equal(info.reasoning, undefined);
});

test('resolveModel: 目录词表优先于静态表', async () => {
  const adapter = catalogAdapter([
    {
      id: 'deepseek-v4-flash',
      output_modalities: ['text'],
      input_modalities: ['text'],
      supported_features: ['reasoning'],
      reasoning_efforts: ['low', 'medium', 'high'],
      default_reasoning_effort: 'high',
    },
  ]);
  await adapter.listModels('sensenova');
  const info = await adapter.resolveModel('sensenova', 'deepseek-v4-flash');
  const reasoning = info.reasoning;
  assert.ok(reasoning);
  assert.deepEqual(reasoning.efforts.map((e) => e.id), ['low', 'medium', 'high'], '目录词表优先');
  assert.equal(reasoning.defaultEffort, 'high');
});

test('resolveModel: 静态表覆盖多个模型族（pro/kimi 官方值域）', async () => {
  const data = [
    { id: 'deepseek-v4-pro', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['reasoning'] },
    { id: 'kimi-k3', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['reasoning'] },
    { id: 'sensenova-6.8-flash-lite', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['reasoning'] },
    { id: 'glm-5.2', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['reasoning'] },
  ];
  const adapter = catalogAdapter(data);
  await adapter.listModels('sensenova');
  const pro = await adapter.resolveModel('sensenova', 'deepseek-v4-pro');
  assert.deepEqual(pro.reasoning?.efforts.map((e) => e.id), ['low', 'high', 'max']);
  const kimi = await adapter.resolveModel('sensenova', 'kimi-k3');
  assert.deepEqual(kimi.reasoning?.efforts.map((e) => e.id), ['low', 'high', 'max']);
  const sn68 = await adapter.resolveModel('sensenova', 'sensenova-6.8-flash-lite');
  assert.deepEqual(sn68.reasoning?.efforts.map((e) => e.id), ['low', 'medium', 'high', 'none']);
  const glm = await adapter.resolveModel('sensenova', 'glm-5.2');
  assert.deepEqual(glm.reasoning?.efforts.map((e) => e.id), ['low', 'medium', 'high', 'none']);
});

test('stream: delta.reasoning_content 与 delta.reasoning 都被映射为 reasoning 增量', async () => {
  // reasoning_content（DeepSeek/Kimi 系）
  const rcSse = [
    'data: {"choices":[{"delta":{"reasoning_content":"思考中"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"content":"答案"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const rcAdapter = chatAdapter(() => sseResponse(rcSse));
  const rcChunks = await collect(rcAdapter.adapter, OPTIONS);
  const rcDeltas = rcChunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c.type === 'reasoning-delta' ? c.text : ''));
  assert.equal(rcDeltas.join(''), '思考中', 'reasoning_content 增量应被发射');

  // reasoning（SenseNova 6.8 系）
  const rSse = [
    'data: {"choices":[{"delta":{"reasoning":"thinking 6.8"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const rAdapter = chatAdapter(() => sseResponse(rSse));
  const rChunks = await collect(rAdapter.adapter, OPTIONS);
  const rDeltas = rChunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c.type === 'reasoning-delta' ? c.text : ''));
  assert.equal(rDeltas.join(''), 'thinking 6.8', 'reasoning 增量应被发射');
});

test('stream: 同一事件 reasoning_content 与 reasoning 共存时以 reasoning_content 优先且不双发', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"优先内容","reasoning":"兜底内容"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const { adapter } = chatAdapter(() => sseResponse(sse));
  const chunks = await collect(adapter, OPTIONS);
  const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta');
  const text = reasoningDeltas.map((c) => (c.type === 'reasoning-delta' ? c.text : '')).join('');
  assert.equal(text, '优先内容', 'reasoning_content 优先');
  assert.equal(reasoningDeltas.length, 1, '同一事件只发一次 reasoning-delta');
});

test('stream: 规范 index 并行工具分片经 BlockAssembler 组装为完整 tool-call 块', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_0","type":"function","function":{"name":"skill","arguments":"{\\"name\\":\\"demo\\""}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"echo "}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"input\\":\\"hi\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"hi\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const { adapter } = chatAdapter(() => sseResponse(sse));
  const blocks = await assembleBlocks(adapter, OPTIONS);
  const toolBlocks = blocks.filter((b) => b.type === 'tool-call');
  assert.equal(toolBlocks.length, 2, '两个并行工具各成一个块');
  const skill = toolBlocks.find((b) => b.type === 'tool-call' && b.name === 'skill');
  const bash = toolBlocks.find((b) => b.type === 'tool-call' && b.name === 'bash');
  assert.ok(skill && skill.type === 'tool-call');
  assert.equal(skill.arguments, '{"name":"demo","input":"hi"}', 'skill arguments 完整拼接');
  assert.ok(bash && bash.type === 'tool-call');
  assert.equal(bash.arguments, '{"command":"echo hi"}', 'bash arguments 按分片拼接');
});

test('stream: 无键并行工具分片经 BlockAssembler 组装为独立完整 tool-call 块', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"skill","arguments":"{\\"name\\":\\"a\\""}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const { adapter } = chatAdapter(() => sseResponse(sse));
  const blocks = await assembleBlocks(adapter, OPTIONS);
  const toolBlocks = blocks.filter((b) => b.type === 'tool-call');
  assert.equal(toolBlocks.length, 2, '无键并行两个工具各成独立块，不并入单槽');
  const skill = toolBlocks.find((b) => b.type === 'tool-call' && b.name === 'skill');
  const bash = toolBlocks.find((b) => b.type === 'tool-call' && b.name === 'bash');
  assert.ok(skill && skill.type === 'tool-call');
  assert.equal(skill.arguments, '{"name":"a"}', 'skill arguments 完整');
  assert.ok(bash && bash.type === 'tool-call');
  assert.equal(bash.arguments, '{"command":"ls"}', 'bash arguments 完整');
});
