/** Responses SSE → 宿主 StreamChunk 翻译（make-responses-default-wire-protocol 3.x；
 * docs/sensenova-upgrade-plan.md §6.6）。
 *
 * 事件映射：output_item.added → block-start（output_index 即 block index；
 * item.type reasoning/message/function_call → 推理/文本/工具块）；
 * reasoning_summary_text.delta → reasoning-delta；output_text.delta → text-delta；
 * function_call_arguments.delta → tool-call-delta（call_id 即 ToolCallId）；
 * output_item.done → block-end；response.completed / incomplete / failed 收尾
 * （不等待也不识别 [DONE]）。并行 function_call 按 output_index 分桶拼接。
 * 不依赖 sequence_number（design §八·14 假设 6）。
 * @module dsh-sensenova-provider/wire/sse-responses
 */
import { LlmError, errorChain } from '@deepseek-ai/dsh-llm';
import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '../brand.ts';
import { mapResponsesUsage } from './usage.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 解析一行 SSE；返回 [事件类型, 事件对象]；[DONE]/空行/注释行/无 type 返回 undefined。 */
function parseResponsesLine(line: string): { type: string; event: Record<string, unknown> } | undefined {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === '[DONE]') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const type = toString(parsed.type);
  if (type === undefined) return undefined;
  return { type, event: parsed };
}

/** output_item.added 的 item.type → 宿主块类型。 */
function blockTypeForItem(itemType: string): 'text' | 'reasoning' | 'tool-call' | undefined {
  if (itemType === 'message') return 'text';
  if (itemType === 'reasoning') return 'reasoning';
  if (itemType === 'function_call') return 'tool-call';
  return undefined; // web_search_call 等内置工具项：插件不用，忽略
}

/** 每个未闭合 output 项的累积状态（按 output_index 分桶，天然支持并行调用）。 */
interface OpenItem {
  blockType: 'text' | 'reasoning' | 'tool-call';
  content: string;
  callId: string | undefined;
  name: string | undefined;
}

interface ResponsesSseState {
  open: Map<number, OpenItem>;
  /** item_id（output_item.* 事件携带）→ output_index；兜底 item_id 寻址。 */
  indexByItemId: Map<string, number>;
  sawContent: boolean;
  finished: boolean;
}

function closeItem(index: number, item: OpenItem | undefined): StreamChunk[] {
  if (item === undefined) return [];
  if (item.blockType === 'tool-call') {
    const name = item.name ?? '';
    if (name === '') return []; // name 始终未到达的残缺调用不产出 tool-call block
    return [{
      type: 'block-end',
      index,
      block: {
        type: 'tool-call',
        id: ToolCallId(item.callId ?? `sensenova-tool-${index}`),
        name,
        arguments: item.content !== '' ? item.content : '{}',
      },
    }];
  }
  return [{
    type: 'block-end',
    index,
    block: item.blockType === 'text'
      ? { type: 'text', text: item.content }
      : { type: 'reasoning', text: item.content },
  }];
}

function closeAllOpen(state: ResponsesSseState): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [index, item] of [...state.open.entries()]) {
    chunks.push(...closeItem(index, item));
  }
  state.open.clear();
  state.indexByItemId.clear();
  return chunks;
}

/** 处理一个 Responses 事件，返回宿主 StreamChunk 序列（无终止语义）。 */
function processResponsesEvent(parsed: { type: string; event: Record<string, unknown> }, state: ResponsesSseState): StreamChunk[] {
  const { type, event } = parsed;
  const chunks: StreamChunk[] = [];
  if (type === 'response.output_item.added') {
    const item = isRecord(event.item) ? event.item : undefined;
    const itemType = toString(item?.type) ?? '';
    const blockType = blockTypeForItem(itemType);
    if (blockType !== undefined && typeof event.output_index === 'number') {
      const index = event.output_index;
      state.open.set(index, {
        blockType,
        content: '',
        callId: toString(item?.call_id),
        name: toString(item?.name),
      });
      const itemId = toString(event.item_id);
      if (itemId !== undefined) state.indexByItemId.set(itemId, index);
      if (blockType === 'tool-call') state.sawContent = true;
      chunks.push({ type: 'block-start', index, blockType });
    }
    return chunks;
  }
  // 增量事件：output_index 优先，item_id 兜底（均无则丢弃，防御性）。
  const resolveIndex = (ev: Record<string, unknown>): number | undefined => {
    if (typeof ev.output_index === 'number' && state.open.has(ev.output_index)) return ev.output_index;
    const itemId = toString(ev.item_id);
    const mapped = itemId !== undefined ? state.indexByItemId.get(itemId) : undefined;
    if (mapped !== undefined && state.open.has(mapped)) return mapped;
    return undefined;
  };
  const deltaText = (ev: Record<string, unknown>): string => toString(ev.delta) ?? '';
  if (type === 'response.output_text.delta') {
    const index = resolveIndex(event);
    if (index === undefined) return chunks;
    const item = state.open.get(index);
    if (item !== undefined && item.blockType === 'text') {
      const delta = deltaText(event);
      item.content += delta;
      state.sawContent = true;
      chunks.push({ type: 'text-delta', index, text: delta });
    }
    return chunks;
  }
  if (type === 'response.reasoning_summary_text.delta') {
    const index = resolveIndex(event);
    if (index === undefined) return chunks;
    const item = state.open.get(index);
    if (item !== undefined && item.blockType === 'reasoning') {
      const delta = deltaText(event);
      item.content += delta;
      state.sawContent = true;
      chunks.push({ type: 'reasoning-delta', index, text: delta });
    }
    return chunks;
  }
  if (type === 'response.function_call_arguments.delta') {
    const index = resolveIndex(event);
    if (index === undefined) return chunks;
    const item = state.open.get(index);
    if (item !== undefined && item.blockType === 'tool-call') {
      const delta = deltaText(event);
      item.content += delta;
      chunks.push({
        type: 'tool-call-delta',
        index,
        id: ToolCallId(item.callId ?? `sensenova-tool-${index}`),
        ...(item.name !== undefined && item.name !== '' ? { name: item.name } : {}),
        argumentsDelta: delta,
      });
    }
    return chunks;
  }
  if (type === 'response.output_item.done') {
    const index = typeof event.output_index === 'number' ? event.output_index : undefined;
    const item = index !== undefined ? state.open.get(index) : undefined;
    if (index !== undefined && item !== undefined) {
      // 收尾项内容以累积为准；事件 item 携带的完整字段兜底（如 done 才出现 name/call_id）。
      const doneItem = isRecord(event.item) ? event.item : undefined;
      if (item.callId === undefined) item.callId = toString(doneItem?.call_id);
      if (item.name === undefined || item.name === '') item.name = toString(doneItem?.name);
      state.open.delete(index);
      const itemId = toString(event.item_id);
      if (itemId !== undefined) state.indexByItemId.delete(itemId);
      chunks.push(...closeItem(index, item));
    }
    return chunks;
  }
  // 终止族事件由调用方处理（需要 finished/usage 语义）。
  return chunks;
}

/** 终止族事件 → 收尾 chunk 序列（close + usage + finish）。 */
function finishFromTerminalEvent(
  parsed: { type: string; event: Record<string, unknown> },
  state: ResponsesSseState,
): StreamChunk[] {
  const { type, event } = parsed;
  const chunks = closeAllOpen(state);
  const response = isRecord(event.response) ? event.response : undefined;
  const usageRec = isRecord(response?.usage) ? response?.usage : undefined;
  if (usageRec !== undefined) chunks.push({ type: 'usage', usage: mapResponsesUsage(usageRec) });
  let reason: FinishReason;
  if (type === 'response.completed') {
    // 扫 output[]：含 function_call → tool-calls，否则 stop（§6.6）。
    const output = Array.isArray(response?.output) ? response!.output : [];
    const hasToolCall = output.some((item) => isRecord(item) && toString(item.type) === 'function_call');
    reason = hasToolCall ? { kind: 'tool-calls' } : { kind: 'stop' };
  } else if (type === 'response.incomplete') {
    const details = isRecord(response?.incomplete_details) ? response?.incomplete_details : undefined;
    const incompleteReason = toString(details?.reason);
    if (incompleteReason === 'max_output_tokens') {
      reason = { kind: 'max-tokens' };
    } else {
      // content_filter 及未知原因按错误收口（spec：incomplete content_filter → error）。
      reason = {
        kind: 'error',
        failure: {
          message: `SenseNova response incomplete: ${incompleteReason ?? 'unknown reason'}`,
          code: 'PROVIDER_PROTOCOL_ERROR',
        },
      };
    }
  } else {
    // response.failed（以及流内 error 事件）：带 error 详情。
    const errorRec = isRecord(event.error) ? event.error : isRecord(response?.error) ? response?.error : undefined;
    const message = toString(errorRec?.message) ?? 'SenseNova response failed';
    reason = { kind: 'error', failure: { message, code: 'PROVIDER_PROTOCOL_ERROR' } };
  }
  chunks.push({ type: 'finish', reason });
  return chunks;
}

function isTerminalType(type: string): boolean {
  return type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed' || type === 'error';
}

/** 判断错误是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason(value: unknown): value is Error {
  return value instanceof Error && value.name === 'TimeoutError';
}

/** 把 Responses SSE 响应体翻译为宿主 StreamChunk 序列（结构与 parseOpenAiSse 对齐：
 * 空闲看门狗、断尾收口、错误映射）。 */
export async function* parseResponsesSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: ResponsesSseState = { open: new Map(), indexByItemId: new Map(), sawContent: false, finished: false };
  let buffer = '';
  let finished = false;
  let watchdogReject: ((error: unknown) => void) | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogReject?.(new DOMException(`SenseNova stream idle for ${idleTimeoutMs}ms`, 'TimeoutError'));
    }, idleTimeoutMs);
  };
  const disarmWatchdog = () => {
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };
  try {
    for (;;) {
      const read: ReadableStreamReadResult<Uint8Array> = await new Promise((resolve, reject) => {
        watchdogReject = reject;
        reader.read().then(resolve, reject);
        armWatchdog();
      });
      disarmWatchdog();
      const { done, value } = read;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const parsed = parseResponsesLine(line);
        if (parsed === undefined) continue; // 含 [DONE]：不识别也不等待（协议纪律）
        if (finished) continue;
        if (isTerminalType(parsed.type)) {
          for (const chunk of finishFromTerminalEvent(parsed, state)) {
            yield chunk;
            if (chunk.type === 'finish') finished = true;
          }
          continue;
        }
        for (const chunk of processResponsesEvent(parsed, state)) yield chunk;
      }
    }
    if (buffer.trim() !== '') {
      const parsed = parseResponsesLine(buffer);
      if (parsed !== undefined && !finished) {
        if (isTerminalType(parsed.type)) {
          for (const chunk of finishFromTerminalEvent(parsed, state)) {
            yield chunk;
            if (chunk.type === 'finish') finished = true;
          }
        } else {
          for (const chunk of processResponsesEvent(parsed, state)) yield chunk;
        }
      }
    }
    if (!finished) {
      // 流断尾（无终止事件）：闭合已开块并按 stop 收口；全程无内容视为空响应。
      for (const chunk of closeAllOpen(state)) yield chunk;
      if (!state.sawContent) {
        throw new LlmError('llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复', 'EMPTY_RESPONSE');
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  } catch (error) {
    if ((signal?.aborted && isTimeoutReason(signal.reason)) || isTimeoutReason(error)) {
      throw new LlmError(
        `llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`,
        'TIMEOUT',
        { cause: error },
      );
    }
    if (signal?.aborted || error instanceof LlmError) throw error;
    throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, 'TRANSPORT', { cause: error });
  } finally {
    disarmWatchdog();
    await reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
}
