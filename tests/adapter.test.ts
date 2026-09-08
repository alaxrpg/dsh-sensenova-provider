import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SensenovaAdapter, type SensenovaConnection } from '../src/adapter.ts';
import { KeyedConcurrencyGate } from '../src/concurrency.ts';
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
function catalogAdapter(data: unknown[], connection: SensenovaConnection = CONNECTION): SensenovaAdapter {
  const body = JSON.stringify({ data });
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
    // 非配额类（非 JSON 体）：30s 在 60000ms 透传上限内，原样透传 providerRetryAfterMs
    // （fix-sensenova-429-quota-retry：上限从 3000ms 提升到 60000ms，对齐 TPM 窗口量级）。
    assert.equal(e.failure.providerRetryAfterMs, 30_000);
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

test('listModels: 旧 modelSelection 不恢复 stale、不隐藏文本模型，image-only 仍排除且未知 id 不合成', async () => {
  // 旧配置可能仍存在于宿主设置中，但适配器只接受最新 /models 目录及自动过滤结果。
  const legacyConnection = {
    ...CONNECTION,
    modelSelection: {
      include: ['sensenova-6.7-flash-lite', 'unknown-id'],
      exclude: ['sensenova-ok'],
    },
  } as unknown as SensenovaConnection;
  const adapter = catalogAdapter([
    { id: 'sensenova-6.7-flash-lite', output_modalities: ['text'], input_modalities: ['text'] },
    { id: 'sensenova-u1-fast', output_modalities: ['image'], input_modalities: ['text'] },
    { id: 'sensenova-ok', output_modalities: ['text'], input_modalities: ['text'] },
  ], legacyConnection);

  const models = await adapter.listModels('sensenova');
  assert.deepEqual(models.map((model) => model.id), ['sensenova-ok']);
  assert.equal(models.some((model) => model.id === 'unknown-id'), false);
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

test('listModels/resolveModel: 识别 SenseNova 目录 max_output_length 字段上报 defaultMaxTokens', async () => {
  const adapter = catalogAdapter([
    {
      id: 'deepseek-v4-flash',
      output_modalities: ['text'],
      input_modalities: ['text'],
      context_length: 1048576,
      max_output_length: 65536,
    },
  ]);
  await adapter.listModels('sensenova');

  const info = await adapter.resolveModel('sensenova', 'deepseek-v4-flash');
  assert.equal(info.context?.contextWindow, 1048576);
  assert.equal(info.defaultMaxTokens, 65536);
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

test('providerRetryPolicy: normal / maxRetries=100 / maxDelayMs=60000', () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
  });
  const policy = adapter.providerRetryPolicy('sensenova');
  assert.ok(policy);
  assert.equal(policy.mode, 'normal');
  if (policy.mode === 'normal') {
    // tune-sensenova-429-retry-budget：预算放大（10→100，100 次 × 15s 封顶档约
    // 25 分钟），退避单次上限维持 60000（对齐 TPM 60s 窗口）。
    assert.equal(policy.maxRetries, 100);
    assert.equal(policy.maxDelayMs, 60_000);
    assert.equal(policy.initialDelayMs, 500);
    // 保留默认 jitterRatio；宿主 localDelay 用 Math.min(..., maxDelayMs) 封顶，
    // 故初始延迟（含最大 jitter 1.1 倍）仍在 60000ms 上限内。
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

test('stream: 429 Retry-After 超过 60000ms 上限不透传 providerRetryAfterMs，且不轮换不冷却', async () => {
  const { adapter, calls, rotateCalls } = chatAdapter(() =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': '900' } }),
  );

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    // 超长 Retry-After 整值不透传（不截断为上限值），由宿主本地退避计算。
    assert.equal(e.failure.providerRetryAfterMs, undefined);
    return true;
  });
  // 429 不轮换、不冷却：单次请求单次调用，账号状态不变。
  assert.equal(calls(), 1);
  assert.equal(rotateCalls.length, 0);
});

test('stream: 429 Retry-After 在 60000ms 上限内透传 providerRetryAfterMs', async () => {
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

// ---- fix-sensenova-429-quota-retry 新增用例 ----

import { classify429Body, TPM_PROBE_BACKOFF_STEPS_MS } from '../src/adapter.ts';

test('classify429Body: 配额类 code 8 与 429001（数字/字符串容错），其余归非配额类', () => {
  // code 8 数字（2026-09-04 实测现场；message 措辞随版本漂移，不参与分类）
  assert.deepEqual(
    classify429Body('{"error":{"message":"rpm exhausted","type":"quota_exceeded_error","code":8}}'),
    { quota: true, retryFloorMs: 15_000, kind: 'rate' },
  );
  // spec 场景样本：code 为字符串 "8"
  assert.deepEqual(
    classify429Body('{"error":{"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}}'),
    { quota: true, retryFloorMs: 15_000, kind: 'rate' },
  );
  // 429001 现场样本（type 实测为 invalid_request_error，字符串 code）
  assert.deepEqual(
    classify429Body('{"error":{"message":"inference tpm exhausted","type":"invalid_request_error","code":"429001"}}'),
    { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' },
  );
  assert.deepEqual(
    classify429Body('{"error":{"message":"inference tpm exhausted","code":429001}}'),
    { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' },
  );
  // 无 code / 其他 code / 非 JSON 体 → 非配额类
  assert.deepEqual(classify429Body('{"error":{"message":"throttled"}}'), { quota: false, retryFloorMs: undefined, kind: undefined });
  assert.deepEqual(classify429Body('{"error":{"message":"bad request","code":"400"}}'), { quota: false, retryFloorMs: undefined, kind: undefined });
  assert.deepEqual(classify429Body('rate limited'), { quota: false, retryFloorMs: undefined, kind: undefined });
  assert.deepEqual(classify429Body(''), { quota: false, retryFloorMs: undefined, kind: undefined });
});

test('stream: 配额类 429（code 8）→ RATE_LIMIT 携带 15000ms 退避下限且不轮换', async () => {
  const { adapter, calls, rotateCalls } = chatAdapter(() =>
    new Response(
      JSON.stringify({ error: { message: 'rpm exhausted', type: 'quota_exceeded_error', code: 8 } }),
      { status: 429 },
    ),
  );

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    // 2026-09-04 实测：速率桶补充 ≈1 个/14s，15s 覆盖一个完整补充周期。
    assert.equal(e.failure.providerRetryAfterMs, 15_000);
    return true;
  });
  assert.equal(calls(), 1);
  assert.equal(rotateCalls.length, 0, '默认（开关关）不轮换');
});

test('stream: 429001 分级探测退避——连续命中 3/5/10/15s 递增封顶，成功后归零', async () => {
  // 2026-09-04 定稿：429001 不做长固定下限，改分级探测（每轮重置、不继承），
  // 连续命中递增 3s→5s→10s→15s 封顶；任一成功即归零回到 3s。
  const tpm = chatAdapter(() =>
    new Response(
      JSON.stringify({ error: { message: 'inference tpm exhausted', type: 'invalid_request_error', code: '429001' } }),
      { status: 429 },
    ),
  );
  const floorOf = async () => {
    let captured = 0;
    await assert.rejects(collect(tpm.adapter, OPTIONS), (err: unknown) => {
      captured = (err as LlmError).failure.providerRetryAfterMs ?? 0;
      return true;
    });
    return captured;
  };
  // 连续 5 次命中：3s / 5s / 10s / 15s / 15s（封顶保持）
  const seq = [await floorOf(), await floorOf(), await floorOf(), await floorOf(), await floorOf()];
  assert.deepEqual(seq, [3_000, 5_000, 10_000, 15_000, 15_000], '连续命中递增 3→5→10→15s 后封顶');
});

test('stream: 429001 成功后探测档位归零，Retry-After 更大时优先、更小时取当前档', async () => {
  // 成功归零：先连续 2 次命中（档位到 5s），再成功，再命中应回到 3s。
  const tpm = chatAdapter(() =>
    new Response(
      JSON.stringify({ error: { message: 'inference tpm exhausted', type: 'invalid_request_error', code: '429001' } }),
      { status: 429 },
    ),
  );
  const floorOf = async (adapter: { adapter: SensenovaAdapter }) => {
    let captured = 0;
    await assert.rejects(collect(adapter.adapter, OPTIONS), (err: unknown) => {
      captured = (err as LlmError).failure.providerRetryAfterMs ?? 0;
      return true;
    });
    return captured;
  };
  assert.equal(await floorOf(tpm), 3_000);
  assert.equal(await floorOf(tpm), 5_000);

  // Retry-After（5s）小于当前档（5s）时取下限（5s）；Retry-After 更大时优先。
  const larger = chatAdapter(() =>
    new Response(JSON.stringify({ error: { message: 'rpm exhausted', code: 8 } }), {
      status: 429,
      headers: { 'retry-after': '90' },
    }),
  );
  let capturedLarger = 0;
  await assert.rejects(collect(larger.adapter, OPTIONS), (err: unknown) => {
    capturedLarger = (err as LlmError).failure.providerRetryAfterMs ?? 0;
    return true;
  });
  // tune-sensenova-429-retry-budget：配额类采用值封顶 60000ms（对齐 maxDelayMs，
  // 宿主 normal 模式在超过单次延迟上限时会直接放弃重试），90s 被封顶为 60s。
  assert.equal(capturedLarger, 60_000, 'Retry-After 更大时优先但封顶 60000ms');

  // 成功一次（切到 200 OK 的 fetch）后，429001 档位归零回到 3s。
  let mode: 'ok' | '429' = '429';
  const mixed = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => {
      if (mode === 'ok') return sseResponse(FIXED_SSE);
      return new Response(
        JSON.stringify({ error: { message: 'inference tpm exhausted', code: '429001' } }),
        { status: 429 },
      );
    }) as typeof fetch,
  });
  assert.equal(await floorOf({ adapter: mixed }), 3_000); // 命中#1 → 3s
  assert.equal(await floorOf({ adapter: mixed }), 5_000); // 命中#2 → 5s
  mode = 'ok';
  await collect(mixed, OPTIONS); // 成功 → 清零
  mode = '429';
  assert.equal(await floorOf({ adapter: mixed }), 3_000, '成功后档位归零回到 3s');
});

/** 构造一个收到 abort 信号才 settle 的挂起 fetch（模拟传输挂起，无响应字节）。 */
function hangingFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    return sseResponse(FIXED_SSE); // 不可达
  }) as typeof fetch;
}

test('stream: 连接/首字节超时以可重试 TIMEOUT 结束并释放并发额度', async () => {
  const gate = new KeyedConcurrencyGate();
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    concurrencyGate: gate,
    timeouts: { connectMs: 50 },
    fetchImpl: hangingFetch(),
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    assert.equal((err as LlmError).code, 'TIMEOUT', '连接超时映射可重试 TIMEOUT');
    return true;
  });
  assert.equal((gate as unknown as { states: Map<string, unknown> }).states.size, 0, '超时后并发额度已释放');
});

test('stream: 宿主 signal abort 保持原样透传（不被连接超时改写为 TIMEOUT）', async () => {
  const controller = new AbortController();
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    timeouts: { connectMs: 5_000 },
    fetchImpl: hangingFetch(),
  });

  const pending = collect(adapter, { ...OPTIONS, signal: controller.signal });
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(pending, (err: unknown) => (err as Error).name === 'AbortError', '宿主取消以 AbortError 原样抛出');
});

test('stream: 流空闲看门狗回收停摆流（TIMEOUT）并释放并发额度', async () => {
  const gate = new KeyedConcurrencyGate();
  const encoder = new TextEncoder();
  // 只发一个 chunk 后静默且不 close 的流。
  const stalledStream = () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
        // 故意不 close：模拟流中途停摆
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    concurrencyGate: gate,
    timeouts: { streamIdleMs: 50 },
    fetchImpl: (async () => stalledStream()) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    assert.equal((err as LlmError).code, 'TIMEOUT', '流停摆按可重试 TIMEOUT 结束');
    return true;
  });
  assert.equal((gate as unknown as { states: Map<string, unknown> }).states.size, 0, '看门狗触发后并发额度已释放');
});

test('stream: 流空闲看门狗收到事件即重置，持续输出的流不受影响', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    timeouts: { streamIdleMs: 50 },
    fetchImpl: (async () => sseResponse(FIXED_SSE)) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.ok(chunks.some((c) => c.type === 'finish'), '持续有事件的流正常完成');
});

test('stream: 健康长流（总时长超过 connectMs）不被连接超时中断', async () => {
  // 回归：连接超时只约束建连/首包；响应头到达后计时器必须清除，body 阶段不得被误杀。
  const encoder = new TextEncoder();
  const slowHealthyStream = () => new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 8; i += 1) {
          await new Promise((r) => setTimeout(r, 20)); // 每 20ms 一个 chunk，总时长 ~160ms > connectMs 50ms
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n`));
        }
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    timeouts: { connectMs: 50, streamIdleMs: 5_000 },
    fetchImpl: (async () => slowHealthyStream()) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.ok(chunks.some((c) => c.type === 'finish'), '总时长超过连接超时的健康流正常完成');
});

test('stream: quotaRotation 环回仅限单次请求内；宿主重试重新探测可切到恢复的 key', async () => {
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  const usedKeys: string[] = [];
  let key2Mode: '429' | 'ok' = '429';
  const rateBody = JSON.stringify({ error: { message: 'rpm exhausted', type: 'quota_exceeded_error', code: 8 } });
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2, quotaRotation: true }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      return rejected === 'key-1' ? 'key-2' : 'key-1';
    },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      usedKeys.push(key);
      if (key === 'key-2' && key2Mode === 'ok') return sseResponse(FIXED_SSE);
      return new Response(rateBody, { status: 429 });
    }) as typeof fetch,
  });

  // 第一轮：k1→k2 均饱和，单次请求内环回抛 RATE_LIMIT（k2 已被 tried 记过，不再切回 k1）。
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.equal((err as LlmError).code, 'RATE_LIMIT');
    return true;
  });
  assert.deepEqual(usedKeys, ['key-1', 'key-2'], '单次请求内 k1→k2 环回');

  // 第二轮（宿主退避后重试同一会话）：从粘住的 k2 起步，此时 k2 已恢复 → 直接成功。
  key2Mode = 'ok';
  const ok = await collect(adapter, OPTIONS);
  assert.ok(ok.some((c) => c.type === 'finish'), '宿主重试时重新探测到 k2 恢复，不再干等退避');
  assert.deepEqual(usedKeys, ['key-1', 'key-2', 'key-2'], '第二轮从粘住的 k2 起步直接成功');
});

test('stream: 并发闸排队超时以可重试 TIMEOUT 结束且不占额度', async () => {
  const gate = new KeyedConcurrencyGate();
  let releaseFirst!: () => void;
  const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    concurrencyGate: gate,
    timeouts: { queueMs: 40 },
    fetchImpl: (async () => {
      await firstHolds;
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });
  // 第一个请求占住唯一额度（缺省并发 1）。
  const first = collect(adapter, OPTIONS);
  await new Promise((r) => setTimeout(r, 10));
  // 第二个请求排队，40ms 后超时。
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    assert.equal((err as LlmError).code, 'TIMEOUT', '排队超时映射可重试 TIMEOUT');
    return true;
  });
  assert.equal((gate as unknown as { states: Map<string, unknown> }).states.size, 1, '排队超时不占额度（仅 first 在途）');
  releaseFirst();
  await first;
});

test('stream: quotaRotation 开启时配额类 429 切 key 重试并粘住新 key', async () => {
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  const usedKeys: string[] = [];
  const rateBody = JSON.stringify({ error: { message: 'rpm exhausted', type: 'quota_exceeded_error', code: 8 } });
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2, quotaRotation: true }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      return rejected === 'key-1' ? 'key-2' : 'key-1';
    },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      usedKeys.push(key);
      if (key === 'key-1') return new Response(rateBody, { status: 429 });
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });

  const chunks = await collect(adapter, OPTIONS);
  assert.ok(chunks.some((c) => c.type === 'finish'), '切换到 key-2 后本次请求重试成功');
  assert.deepEqual(rotateCalls, [{ rejected: 'key-1', rejection: 'quota-exhausted' }], '配额类 429 以 quota-exhausted 轮换（不写账号状态）');
  assert.deepEqual(usedKeys, ['key-1', 'key-2'], '同一请求内切到 key-2 重试');

  // 后续请求：resolveApiKey 仍返回 key-1，但粘性指针让请求直接从 key-2 起步。
  const second = await collect(adapter, OPTIONS);
  assert.ok(second.some((c) => c.type === 'finish'));
  assert.equal(rotateCalls.length, 1, '粘住 key-2，未再次轮换');
  assert.deepEqual(usedKeys, ['key-1', 'key-2', 'key-2'], '后续请求直接使用粘住的 key-2');
});

test('stream: quotaRotation 关闭时配额类 429 不轮换（行为与现状一致）', async () => {
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  let calls = 0;
  const rateBody = JSON.stringify({ error: { message: 'rpm exhausted', type: 'quota_exceeded_error', code: 8 } });
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2 }), // quotaRotation 缺省 = 关
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      return 'key-2';
    },
    fetchImpl: (async () => {
      calls += 1;
      return new Response(rateBody, { status: 429 });
    }) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    assert.equal(e.failure.providerRetryAfterMs, 15_000, '配额类退避下限仍生效');
    return true;
  });
  assert.equal(calls, 1, '不换 key 重试');
  assert.equal(rotateCalls.length, 0, '不触发账号轮换');
});

test('stream: quotaRotation 环回无新 key 时停留在当前 key 抛 RATE_LIMIT（退避下限生效）', async () => {
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  const usedKeys: string[] = [];
  const rateBody = JSON.stringify({ error: { message: 'inference tpm exhausted', type: 'invalid_request_error', code: 429001 } });
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2, quotaRotation: true }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      // 模拟 pool.resolveKey({ exclude: rejectedKey })：两把 key 中排除被拒者返回另一把。
      return rejected === 'key-1' ? 'key-2' : 'key-1';
    },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      usedKeys.push(key);
      return new Response(rateBody, { status: 429 });
    }) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    // 换 key 时计数清零，key-2 首次命中 → 分级探测第 1 档 = 3s。
    assert.equal(e.failure.providerRetryAfterMs, 3_000, '环回后按 TPM 分级探测档位等待（3s）');
    return true;
  });
  assert.deepEqual(rotateCalls.map((c) => c.rejection), ['quota-exhausted', 'quota-exhausted'], '两次均为配额类轮换（不禁用）');
  assert.deepEqual(usedKeys, ['key-1', 'key-2'], '切到 key-2 仍被拒后环回');
  assert.equal(usedKeys.filter((k) => k === 'key-1').length, 1, '环回 key-1 已试过 → 停留在 key-2，不重复切换');
});

test('resolveAdapterOptions: quotaRotation 缺省 false，显式 true 透传', () => {
  assert.equal(resolveAdapterOptions({}).quotaRotation, false);
  assert.equal(resolveAdapterOptions({ quotaRotation: true }).quotaRotation, true);
  assert.equal(resolveAdapterOptions({ quotaRotation: false }).quotaRotation, false);
});
