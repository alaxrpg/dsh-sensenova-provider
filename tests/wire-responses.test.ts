/** make-responses-default-wire-protocol 决策表 / Responses 请求体 / SSE 映射 / 兜底接线测试。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SensenovaAdapter, type SensenovaConnection } from '../src/adapter.ts';
import { resolveWirePlan } from '../src/wire/plan.ts';
import { buildResponsesBody } from '../src/wire/body-responses.ts';
import { parseResponsesSse } from '../src/wire/sse-responses.ts';
import { mapResponsesUsage } from '../src/wire/usage.ts';
import { factsFor } from '../src/wire/facts.ts';

const MODEL = 'sensenova-6.8-flash-lite'; // responsesDefaultEffort 'high'
const CONNECTION: SensenovaConnection = { apiBase: 'https://example.invalid', accountCount: 2 };

function opts(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'sensenova', model: MODEL, messages: [], ...extra };
}

function sseResponse(sseText: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseText));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collectSse(sseText: string): Promise<StreamChunk[]> {
  const body = sseResponse(sseText).body!;
  const chunks: StreamChunk[] = [];
  for await (const chunk of parseResponsesSse(body, undefined, 60000)) chunks.push(chunk);
  return chunks;
}

// ---- 1. 决策表（§5.2 五行 + 强制模式） ----

test('plan: auto 干净请求 → responses-default', () => {
  const plan = resolveWirePlan(opts(), {}, factsFor(MODEL, undefined), new Set());
  assert.deepEqual(plan, { wire: 'responses', reason: 'responses-default' });
});

test('plan: stop 非空 → downgrade-stop（stop 不支持是降级条件而非发送字段）', () => {
  const plan = resolveWirePlan(opts({ stop: ['END'] }), {}, factsFor(MODEL, undefined), new Set());
  assert.deepEqual(plan, { wire: 'chat-completions', reason: 'downgrade-stop' });
});

test('plan: 模型不支持 Responses（未知模型兜底）→ downgrade-unsupported-model', () => {
  const plan = resolveWirePlan(opts({ model: 'test-model' }), {}, factsFor('test-model', undefined), new Set());
  assert.deepEqual(plan, { wire: 'chat-completions', reason: 'downgrade-unsupported-model' });
});

test('plan: effort 偏离 Responses 默认档（非 none）→ downgrade-effort；等于默认/none/未选不降级', () => {
  const facts = factsFor(MODEL, undefined);
  assert.deepEqual(resolveWirePlan(opts({ reasoningEffort: 'low' as never }), {}, facts, new Set()), { wire: 'chat-completions', reason: 'downgrade-effort' });
  // glm-5.2 默认 max：high 属偏离。
  const glm = factsFor('glm-5.2', undefined);
  assert.deepEqual(resolveWirePlan(opts({ model: 'glm-5.2', reasoningEffort: 'high' as never }), {}, glm, new Set()), { wire: 'chat-completions', reason: 'downgrade-effort' });
  // 等于默认档：不降级（Responses 不发 reasoning）。
  assert.deepEqual(resolveWirePlan(opts({ reasoningEffort: 'high' as never }), {}, facts, new Set()), { wire: 'responses', reason: 'responses-default' });
  // none：不降级（Responses 显式 reasoning.effort=none）。
  assert.deepEqual(resolveWirePlan(opts({ reasoningEffort: 'none' as never }), {}, facts, new Set()), { wire: 'responses', reason: 'responses-default' });
});

test('plan: 运行时 400 标记（§5.3 responsesUnsupported）→ downgrade-runtime-marked', () => {
  const plan = resolveWirePlan(opts(), {}, factsFor(MODEL, undefined), new Set([MODEL]));
  assert.deepEqual(plan, { wire: 'chat-completions', reason: 'downgrade-runtime-marked' });
});

test('plan: 强制 chat-completions 恒 forced-chat（无降级判定）', () => {
  const plan = resolveWirePlan(opts({ stop: ['END'] }), { wireProtocol: 'chat-completions' }, factsFor(MODEL, undefined), new Set());
  assert.deepEqual(plan, { wire: 'chat-completions', reason: 'forced-chat' });
});

test('plan: 强制 responses 命中降级 → 抛 INVALID_REQUEST 并说明切换方法', () => {
  assert.throws(
    () => resolveWirePlan(opts({ stop: ['END'] }), { wireProtocol: 'responses' }, factsFor(MODEL, undefined), new Set()),
    (error: unknown) => error instanceof LlmError && error.code === 'INVALID_REQUEST' && /chat-completions/.test(error.message),
  );
});

// ---- 2. Responses 请求体 ----

const HISTORY: GenerateOptions['messages'] = [
  { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: 'call-1' as never, name: 'bash', arguments: '{"cmd":"ls"}' },
      { type: 'tool-call', id: '' as never, name: '', arguments: '' }, // 空 name：应被丢弃
    ],
  } as unknown as GenerateOptions['messages'][number],
  { role: 'tool', toolCallId: 'call-1' as never, content: [{ type: 'text', text: 'out-1' }] } as never,
  { role: 'tool', toolCallId: 'orphan' as never, content: [{ type: 'text', text: 'lonely' }] } as never, // 孤立结果：丢弃
  { role: 'user', content: [{ type: 'text', text: 'go on' }] },
];

test('body: input[] 映射 + instructions 合并 + 四防御', () => {
  const body = buildResponsesBody(opts({ messages: HISTORY, system: 'extra rules' }), undefined, {});
  // options.system 与 system 消息合并为 instructions（实现取 options.system 在前）。
  assert.equal(body.instructions, 'extra rules\n\nbe brief');
  const input = body.input as Array<Record<string, unknown>>;
  // assistant 消息内 function_call 先于 output_text 发出（实现语义：调用与结果相邻）。
  assert.deepEqual(input.map((item) => item.type ?? `${item.role}:${(item.content as Array<{ type: string }>)[0]?.type}`), [
    'user:input_text',
    'function_call',
    'assistant:output_text',
    'function_call_output',
    'user:input_text',
  ]);
  // user 文本块形状。
  assert.deepEqual(input[0], { role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
  // assistant tool-call：call_id 稳定、参数为字符串。
  const call = input[1];
  assert.equal(call.call_id, 'call-1');
  assert.equal(call.name, 'bash');
  assert.equal(call.arguments, '{"cmd":"ls"}');
  // 空 name 的残缺调用被丢弃（input 中只有一个 function_call）。
  // tool-result：call_id 映射回原 id，output 为文本。
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call-1', output: 'out-1' });
});

test('body: 空 name 工具调用的 id 合成与参数补 {}（清洗防御在 Responses 同样生效）', () => {
  const messages: GenerateOptions['messages'] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '' },
        { type: 'tool-call', id: '' as never, name: 'keep', arguments: '' },
      ],
    } as unknown as GenerateOptions['messages'][number],
    { role: 'tool', toolCallId: '' as never, content: [] } as never,
  ];
  const body = buildResponsesBody(opts({ messages }), undefined, {});
  const call = (body.input as Array<Record<string, unknown>>).find((item) => item.type === 'function_call');
  assert.ok(call);
  assert.match(String(call.call_id), /^sensenova-sanitized-\d+$/);
  assert.equal(call.arguments, '{}');
  const output = (body.input as Array<Record<string, unknown>>).find((item) => item.type === 'function_call_output');
  assert.equal(output?.output, '(no output)');
});

test('body: 协议纪律——永不含 store/background/previous_response_id/truncation/include/stop', () => {
  const body = buildResponsesBody(opts({ messages: HISTORY, system: 's' }), undefined, {});
  for (const forbidden of ['store', 'background', 'previous_response_id', 'truncation', 'include', 'stop']) {
    assert.equal(forbidden in body, false, `${forbidden} 不应出现在 Responses 请求体`);
  }
  assert.equal(body.stream, true);
  assert.equal('temperature' in body, false); // 未显式设置不发（Responses 默认 0.6）
  assert.equal('reasoning' in body, false); // 未选档不发
});

test('body: temperature 仅显式设置才发；kimi 固定 temperature 仍被裁剪', () => {
  const explicit = buildResponsesBody(opts({ temperature: 0.2 }), undefined, {});
  assert.equal(explicit.temperature, 0.2);
  const kimi = buildResponsesBody(opts({ model: 'kimi-k3', temperature: 0.2 }), undefined, {});
  assert.equal('temperature' in kimi, false);
});

test('body: reasoning 仅 effort=none 时发送（含 summary 配置）；等于默认档不发', () => {
  const none = buildResponsesBody(opts({ reasoningEffort: 'none' as never }), undefined, { reasoningSummary: 'detailed' });
  assert.deepEqual(none.reasoning, { effort: 'none', summary: 'detailed' });
  const noneDefault = buildResponsesBody(opts({ reasoningEffort: 'none' as never }), undefined, {});
  assert.deepEqual(noneDefault.reasoning, { effort: 'none', summary: 'auto' });
  const equal = buildResponsesBody(opts({ reasoningEffort: 'high' as never }), undefined, {});
  assert.equal('reasoning' in equal, false);
});

test('body: max_output_tokens 按 responsesMaxOutputTokens 钳制', () => {
  const clamped = buildResponsesBody(opts({ maxTokens: 1000000 }), undefined, {});
  assert.equal(clamped.max_output_tokens, 65536); // 6.8 静态表 responsesMaxOutputTokens
  const normal = buildResponsesBody(opts({ maxTokens: 512 }), undefined, {});
  assert.equal(normal.max_output_tokens, 512);
  const absent = buildResponsesBody(opts({}), undefined, {});
  assert.equal('max_output_tokens' in absent, false);
});

test('body: tools 扁平形状（无 strict/无嵌套 function 层）', () => {
  const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } } as never];
  const body = buildResponsesBody(opts({ tools }), undefined, {});
  assert.deepEqual(body.tools, [{ type: 'function', name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }]);
});

// ---- 3. SSE 事件流映射（§6.6） ----

const TEXT_SSE = [
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1"}}',
  '',
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"Hello"}',
  '',
  'data: {"type":"response.output_text.delta","output_index":0,"delta":" world"}',
  '',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1"}}',
  '',
  'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","id":"msg_1"}],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":2}}}}',
  '',
].join('\n');

test('sse: 文本流→block-start/text-delta×2/block-end/usage/finish（无 [DONE] 收尾）', async () => {
  const chunks = await collectSse(TEXT_SSE);
  assert.deepEqual(chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text), ['Hello', ' world']);
  assert.ok(chunks.some((c) => c.type === 'block-start' && (c as { index: number }).index === 0));
  assert.ok(chunks.some((c) => c.type === 'block-end'));
  const usage = chunks.find((c) => c.type === 'usage') as unknown as { usage: Record<string, number> } | undefined;
  assert.ok(usage);
  assert.equal(usage.usage.inputTokens, 10); // §3.4 初版直取（TODO 实测点）
  assert.equal(usage.usage.outputTokens, 5);
  assert.equal(usage.usage.cacheReadTokens, 4);
  assert.equal(usage.usage.reasoningTokens, 2);
  const finish = chunks[chunks.length - 1];
  assert.equal(finish.type, 'finish');
  assert.deepEqual((finish as { reason: { kind: string } }).reason, { kind: 'stop' });
});

test('sse: [DONE] 行被忽略（不识别也不等待）', async () => {
  const sse = TEXT_SSE + '\ndata: [DONE]\n\n';
  const chunks = await collectSse(sse);
  assert.equal(chunks[chunks.length - 1].type, 'finish');
});


/** 构造一条 function_call_arguments.delta 事件行（用 JSON.stringify 避免手工转义）。 */
function deltaLine(outputIndex: number, text: string): string {
  return `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: outputIndex, delta: text })}`;
}

test('sse: 交错并行 function_call 按分桶拼接，finish=tool-calls', async () => {
  const chunks = await collectSse([
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call-a","name":"bash"}}',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call-b","name":"read"}}',
    deltaLine(0, '{"cmd":'),
    deltaLine(1, '{"path":'),
    deltaLine(0, '"ls"}'),
    deltaLine(1, '"a"}'),
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call-a","name":"bash"}}',
    'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call-b","name":"read"}}',
    'data: {"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call-a"},{"type":"function_call","call_id":"call-b"}]}}',
  ].join('\n'));
  const ends = chunks.filter((c) => c.type === 'block-end') as unknown as Array<{ index: number; block: { type: string; id?: string; name?: string; arguments?: string } }>;
  assert.equal(ends.length, 2);
  const a = ends.find((e) => e.index === 0)!.block;
  const b = ends.find((e) => e.index === 1)!.block;
  assert.equal(a.type, 'tool-call');
  assert.equal(String(a.id), 'call-a');
  assert.equal(a.arguments, '{"cmd":"ls"}');
  assert.equal(String(b.id), 'call-b');
  assert.equal(b.arguments, '{"path":"a"}');
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } };
  assert.equal(finish.reason.kind, 'tool-calls');
});

test('sse: 推理摘要 delta → reasoning-delta 块', async () => {
  const chunks = await collectSse([
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1"}}',
    'data: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"thinking"}',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1"}}',
    'data: {"type":"response.completed","response":{"output":[{"type":"reasoning","id":"rs_1"}]}}',
  ].join('\n'));
  const reasoningDelta = chunks.find((c) => c.type === 'reasoning-delta') as { text: string } | undefined;
  assert.equal(reasoningDelta?.text, 'thinking');
  const end = chunks.find((c) => c.type === 'block-end') as unknown as { block: { type: string; text: string } };
  assert.equal(end.block.type, 'reasoning');
  assert.equal(end.block.text, 'thinking');
});

test('sse: incomplete max_output_tokens → max-tokens；content_filter → error', async () => {
  const maxTokens = await collectSse([
    'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"output":[]}}',
  ].join('\n'));
  const finish = maxTokens[maxTokens.length - 1] as { reason: { kind: string } };
  assert.equal(finish.reason.kind, 'max-tokens');
  const filtered = await collectSse([
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"partial"}',
    'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"},"output":[]}}',
  ].join('\n'));
  const last = filtered[filtered.length - 1] as { reason: { kind: string; failure?: { code: string } } };
  assert.equal(last.reason.kind, 'error');
  assert.equal(last.reason.failure?.code, 'PROVIDER_PROTOCOL_ERROR');
  // 已开块在 error 前被闭合。
  assert.ok(filtered.some((c) => c.type === 'block-end'));
});

test('sse: failed → error 且带错误消息', async () => {
  const chunks = await collectSse([
    'data: {"type":"response.failed","response":{"error":{"message":"upstream exploded"}}}',
  ].join('\n'));
  const finish = chunks[chunks.length - 1] as { reason: { kind: string; failure: { message: string; code: string } } };
  assert.equal(finish.reason.kind, 'error');
  assert.equal(finish.reason.failure.message, 'upstream exploded');
  assert.equal(finish.reason.failure.code, 'PROVIDER_PROTOCOL_ERROR');
});

test('sse: 流断尾（无终止事件）→ 闭合已开块并 stop 收口；全程无内容 → EMPTY_RESPONSE', async () => {
  const truncated = await collectSse([
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"partial"}',
  ].join('\n'));
  const finish = truncated[truncated.length - 1] as { reason: { kind: string } };
  assert.equal(finish.reason.kind, 'stop');
  await assert.rejects(
    collectSse(''),
    (error: unknown) => error instanceof LlmError && error.code === 'EMPTY_RESPONSE',
  );
});

// ---- 4. usage 映射（§6.7） ----

test('usage: input/output/total 直取 + cached/reasoning 细分', () => {
  const usage = mapResponsesUsage({
    input_tokens: 100, output_tokens: 40, total_tokens: 140,
    input_tokens_details: { cached_tokens: 60 },
    output_tokens_details: { reasoning_tokens: 12 },
  });
  assert.deepEqual(usage, {
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    cacheReadTokens: 60,
    reasoningTokens: 12,
  });
});

// ---- 5. adapter 接线（端点分派 / 400 兜底三场景 / 401 轮换同 wire） ----

function recorder(fetchImpl: typeof fetch, connection: SensenovaConnection = CONNECTION): { adapter: SensenovaAdapter; urls: string[] } {
  const urls: string[] = [];
  const adapter = new SensenovaAdapter({
    options: () => connection,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => 'key-2',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return fetchImpl(input, init);
    }) as typeof fetch,
  });
  return { adapter, urls };
}

const RESP_SSE = [
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}',
  'data: {"type":"response.output_text.delta","output_index":0,"delta":"ok"}',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message"}}',
  'data: {"type":"response.completed","response":{"output":[{"type":"message"}]}}',
].join('\n');

const CHAT_SSE = [
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
].join('\n');

async function collect(adapter: SensenovaAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

test('adapter: auto 模式打 /responses 端点并消费 Responses SSE', async () => {
  const { adapter, urls } = recorder((async () => sseResponse(RESP_SSE)) as typeof fetch);
  const chunks = await collect(adapter, opts());
  assert.deepEqual(urls, ['https://example.invalid/responses']);
  assert.ok(chunks.some((c) => c.type === 'text-delta'));
  assert.equal(chunks[chunks.length - 1].type, 'finish');
});

test('adapter: 强制 chat-completions 打 /chat/completions 端点（4.4 零回归通道）', async () => {
  const { adapter, urls } = recorder((async () => sseResponse(CHAT_SSE)) as typeof fetch, { ...CONNECTION, wireProtocol: 'chat-completions' });
  const chunks = await collect(adapter, opts());
  assert.deepEqual(urls, ['https://example.invalid/chat/completions']);
  assert.ok(chunks.some((c) => c.type === 'text-delta'));
});

test('adapter: 400 兜底场景一——invalid_request_error 立即同请求换 Chat 成功', async () => {
  let call = 0;
  const { adapter, urls } = recorder((async (input: RequestInfo | URL) => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } }), { status: 400 });
    }
    assert.ok(String(input).endsWith('/chat/completions'), '兜底后必须换 Chat 端点');
    return sseResponse(CHAT_SSE);
  }) as typeof fetch);
  const chunks = await collect(adapter, opts());
  assert.deepEqual(urls, ['https://example.invalid/responses', 'https://example.invalid/chat/completions']);
  assert.ok(chunks.some((c) => c.type === 'text-delta'));
  assert.equal(chunks[chunks.length - 1].type, 'finish');
});

test('adapter: 400 兜底场景二——标记进程内集合，后续请求直连 Chat', async () => {
  let call = 0;
  const { adapter, urls } = recorder((async () => {
    call += 1;
    return call === 1
      ? new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } }), { status: 400 })
      : sseResponse(CHAT_SSE);
  }) as typeof fetch);
  await collect(adapter, opts());
  await collect(adapter, opts());
  assert.deepEqual(urls, [
    'https://example.invalid/responses',
    'https://example.invalid/chat/completions',
    'https://example.invalid/chat/completions',
  ]);
});

test('adapter: 400 兜底场景三——集合不持久化，新适配器实例（重启等价）重新尝试 Responses', async () => {
  const make = () => recorder((async () => sseResponse(RESP_SSE)) as typeof fetch);
  const first = make();
  await collect(first.adapter, opts());
  assert.deepEqual(first.urls, ['https://example.invalid/responses']);
  const second = make();
  await collect(second.adapter, opts());
  assert.deepEqual(second.urls, ['https://example.invalid/responses']);
});

test('adapter: 400 非 invalid_request_error 不触发兜底（直接抛 HTTP 错误）', async () => {
  const { adapter, urls } = recorder((async () =>
    new Response(JSON.stringify({ error: { type: 'server_error', message: 'boom' } }), { status: 400 })) as typeof fetch);
  await assert.rejects(
    collect(adapter, opts()),
    (error: unknown) => error instanceof LlmError && error.code === 'PROVIDER_HTTP_ERROR',
  );
  assert.deepEqual(urls, ['https://example.invalid/responses']);
});

test('adapter: 401 轮换重试保持同一 wire（粘性；4.2）', async () => {
  let call = 0;
  const rotateCalls: string[] = [];
  const urls: string[] = [];
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected) => {
      rotateCalls.push(rejected);
      return 'key-2';
    },
    fetchImpl: (async (input: RequestInfo | URL) => {
      call += 1;
      urls.push(String(input));
      return call === 1 ? new Response('unauthorized', { status: 401 }) : sseResponse(RESP_SSE);
    }) as typeof fetch,
  });
  const chunks = await collect(adapter, opts());
  assert.deepEqual(urls, ['https://example.invalid/responses', 'https://example.invalid/responses']);
  assert.deepEqual(rotateCalls, ['key-1']);
  assert.ok(chunks.some((c) => c.type === 'text-delta'));
});
