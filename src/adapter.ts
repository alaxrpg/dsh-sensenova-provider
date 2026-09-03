/**
 * SenseNova（OpenAI 兼容）provider 适配器（host 侧）。
 *
 * 复用参考插件 @mars-sea/dsh-commandcode-provider 的适配器结构，但只保留
 * OpenAI 兼容的目录拉取与 SSE 流式翻译，外加「流开始前的 401 账号轮换」
 * （429 不轮换：一个会话固定一个 key，保护服务端按 key 命中的 prompt 缓存，
 * 429 交由宿主重试层退避后原 key 重试）。
 * 与 pi-ai 的 `toStreamChunks` 不同，这里直接消费 OpenAI SSE（`data:` 行、
 * `[DONE]`、`choices[].delta`、`finish_reason`、`usage`），不引入第三方流库。
 *
 * 适配器刻意不依赖 cordis/schemastery：每请求的连接事实与 key 解析/轮换
 * 全部通过构造注入，node 测试可直接驱动。
 *
 * @module dsh-sensenova-provider/adapter
 */
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  attributionHeaders,
  errorChain,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
  ToolResultBlock,
} from '@deepseek-ai/dsh-llm';
import { parseRetryAfterMs } from './accounts.ts';

/**
 * SenseNova 目录通常不披露上下文字段，这里用 131072 作为合理默认
 * （DeepSeek 系列与 SenseNova 常见模型窗口）；目录有字段时优先采用。
 */
const DEFAULT_CONTEXT_WINDOW = 131_072;
const MODELS_TIMEOUT_MS = 10_000;
/** 提交给 provider 重试层的延迟上限（毫秒）：本地退避与 429 Retry-After 均受此约束。 */
const PROVIDER_RETRY_AFTER_CAP_MS = 3_000;
/** 已知不可路由的模型 id 清单（已下线路由，调用返回 404）。 */
const KNOWN_UNROUTABLE_MODELS: ReadonlySet<string> = new Set(['sensenova-6.7-flash-lite']);
/** 明确的模型不可用错误码（不在默认可重试集合内，故不触发 provider 重试）。 */
const MODEL_NOT_FOUND_CODE = 'MODEL_NOT_FOUND';
/** 模型 id → 标准显示名的显式品牌映射。 */
const DISPLAY_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ['sensenova-6.7-flash-lite', 'Sensenova 6.7 Flash Lite'],
]);
/** 官方文档声明的模型族推理档位（值为 API wire 原值）。 */
const KNOWN_EFFORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['sensenova-6.8-flash-lite', ['low', 'medium', 'high', 'none']],
  ['deepseek-v4-flash', ['low', 'medium', 'high', 'none']],
  ['deepseek-v4-pro', ['low', 'high', 'max']],
  ['glm-5.2', ['low', 'medium', 'high', 'none']],
  ['kimi-k3', ['low', 'high', 'max']],
]);

/** 手动模型可选覆盖（用户设置持久化）。 */
export interface ModelSelection {
  include: readonly string[];
  exclude: readonly string[];
}

export interface SensenovaConnection {
  apiBase: string;
  /** 已配置账户槽位总数，用于轮换上限（tried.size < accountCount）。 */
  accountCount: number;
  /** 手动模型可选覆盖；缺省等价于空选择（自动过滤）。 */
  modelSelection?: ModelSelection;
}

const EMPTY_MODEL_SELECTION: ModelSelection = { include: [], exclude: [] };

export interface SensenovaAdapterDeps {
  /** 每请求的连接事实（apiBase、账户数）。 */
  options: () => SensenovaConnection;
  /** 解析一个可用 key（无可解析 key 时抛 MISSING_CREDENTIAL）。 */
  resolveApiKey: (connection: SensenovaConnection) => Promise<string>;
  /** 记录一次拒绝（仅 401 会禁用账号）并轮换到下一个 key；返回 undefined 表示无更多 key。 */
  rotateApiKey: (
    rejectedKey: string,
    rejection: 'invalid-credential',
  ) => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}

/** 目录条目：宿主所需的能力元数据快照（listModels 后缓存，resolveModel 消费）。 */
interface CatalogEntry {
  id: string;
  name: string;
  inputModalities: readonly ModelModality[];
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: LlmModelReasoningInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 把模型 id 标准化为可读显示名：显式映射优先，否则按品牌前缀回退。 */
function displayNameFor(id: string): string {
  const override = DISPLAY_NAME_OVERRIDES.get(id);
  if (override !== undefined) return override;
  const normalized = id.trim();
  // 回退规则：按连字符/下划线切词（点号属于版本号，如 6.8、u1.5，需保留），
  // 再按大写边界切词，首字母大写其余小写。
  const words = normalized
    .split(/[-_]+/)
    .filter((part) => part !== '')
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/));
  if (words.length === 0) return normalized;
  const titled = words.map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word));
  return titled.join(' ').replace(/\s+/g, ' ').trim();
}

/** 递归展平工具结果内容为纯文本。 */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => block.type === 'text' ? block.text : block.type === 'tool-result' ? toolResultText(block.content) : '')
    .join('');
}

/** 拼出某条消息的可见文本。 */
function flattenText(message: Message): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

/** 从目录条目读取一个正数能力字段（按优先级），缺失/非法返回 undefined。 */
function firstPositiveNumber(raw: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function firstContextField(raw: Record<string, unknown>): number | undefined {
  return firstPositiveNumber(raw, ['context_length', 'context_window', 'max_context_length', 'contextLength']);
}

function firstMaxOutputField(raw: Record<string, unknown>): number | undefined {
  return firstPositiveNumber(raw, ['max_tokens', 'max_output_tokens', 'max_completion_tokens', 'maxTokens', 'maxOutputTokens', 'maxCompletionTokens']);
}

/** 把目录声明的输入模态映射为宿主 ModelModality 列表；未声明时回退 ['text']。 */
function inputModalitiesFrom(raw: Record<string, unknown>): readonly ModelModality[] {
  const declared = raw.input_modalities;
  if (!Array.isArray(declared)) return ['text'];
  const modalities: ModelModality[] = [];
  for (const item of declared) {
    const modality = toString(item);
    if (modality === 'text' || modality === 'image') {
      if (!modalities.includes(modality)) modalities.push(modality);
    }
  }
  return modalities.length > 0 ? modalities : ['text'];
}

/** 读取目录中的 effort 词表字段；返回字符串数组或 undefined（无明确词表）。 */
function effortListField(raw: Record<string, unknown>): readonly string[] | undefined {
  for (const key of ['reasoning_efforts', 'reasoning_levels']) {
    const value = raw[key];
    if (Array.isArray(value)) {
      const efforts = value.filter((item): item is string => typeof item === 'string' && item !== '');
      if (efforts.length > 0) return efforts;
    }
  }
  return undefined;
}

/** 读取嵌套 reasoning.efforts / thinking.efforts 词表；返回字符串数组或 undefined。 */
function nestedEffortListField(raw: Record<string, unknown>): readonly string[] | undefined {
  for (const key of ['reasoning', 'thinking']) {
    const holder = raw[key];
    if (!isRecord(holder)) continue;
    const efforts = holder.efforts;
    if (Array.isArray(efforts)) {
      const list = efforts.filter((item): item is string => typeof item === 'string' && item !== '');
      if (list.length > 0) return list;
    }
  }
  return undefined;
}

/** 读取目录中的默认 effort 字段；返回字符串或 undefined。 */
function defaultEffortField(raw: Record<string, unknown>): string | undefined {
  const direct = raw.default_reasoning_effort;
  if (typeof direct === 'string' && direct !== '') return direct;
  for (const key of ['reasoning', 'thinking']) {
    const holder = raw[key];
    if (isRecord(holder)) {
      const value = holder.defaultEffort ?? holder.default_effort;
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return undefined;
}

/** 目录是否声明支持 reasoning；仅用于静态已知模型族的档位补全。 */
function hasReasoningSupport(raw: Record<string, unknown>): boolean {
  const features = raw.supported_features;
  if (Array.isArray(features) && features.includes('reasoning')) return true;
  // 兼容旧目录的宽松支持标记，但不把任意模型 id 当作已知模型。
  if (raw.reasoning_effort !== undefined) return true;
  const thinking = raw.thinking;
  return thinking === true || isRecord(thinking);
}

/** 解析目录条目的 reasoning 词表；目录词表优先，静态表仅补全已知且有支持标记的模型。 */
function reasoningInfoFrom(raw: Record<string, unknown>, modelId: string): LlmModelReasoningInfo | undefined {
  const efforts = effortListField(raw) ?? nestedEffortListField(raw);
  const knownEfforts = KNOWN_EFFORTS.get(modelId);
  const selectedEfforts = efforts ?? (knownEfforts !== undefined && hasReasoningSupport(raw) ? knownEfforts : undefined);
  if (selectedEfforts === undefined || selectedEfforts.length === 0) return undefined;
  const infos = selectedEfforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort }));
  const defaultEffort = efforts !== undefined ? defaultEffortField(raw) : undefined;
  const defaultId = defaultEffort !== undefined && selectedEfforts.includes(defaultEffort)
    ? ReasoningEffortId(defaultEffort)
    : undefined;
  return {
    efforts: infos,
    ...(defaultId !== undefined ? { defaultEffort: defaultId } : {}),
  };
}

/** 解析 OpenAI 模型目录为目录条目；应用自动过滤与手动 include/exclude 覆盖。 */
function parseCatalog(value: unknown, failedModels: ReadonlySet<string>, selection: ModelSelection): CatalogEntry[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new LlmError('llm-sensenova: unexpected models response shape', 'PROVIDER_PROTOCOL_ERROR');
  }
  const include = new Set(selection.include);
  const exclude = new Set(selection.exclude);
  const out: CatalogEntry[] = [];
  for (const raw of value.data) {
    if (!isRecord(raw)) continue;
    const id = toString(raw.id);
    if (id === undefined || id === '') continue;
    // 1) image-only 永远排除：output_modalities 必须含 text，否则不可进入 chat 选择器。
    const output = raw.output_modalities;
    const outputsText = Array.isArray(output) ? output.some((item) => toString(item) === 'text') : false;
    if (!outputsText) continue;
    // 2) 显式 exclude 优先（即使 include 也排除）。
    if (exclude.has(id)) continue;
    // 3) 显式 include 可重新加入目录中的已知/失败 stale 文本模型。
    // 4) 否则按已知不可路由清单与失败缓存过滤。
    if (!include.has(id)) {
      if (KNOWN_UNROUTABLE_MODELS.has(id)) continue;
      if (failedModels.has(id)) continue;
    }
    const contextWindow = firstContextField(raw);
    const maxOutputTokens = firstMaxOutputField(raw);
    const reasoning = reasoningInfoFrom(raw, id);
    out.push({
      id,
      name: displayNameFor(id),
      inputModalities: inputModalitiesFrom(raw),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    });
  }
  return out;
}

/** 把 OpenAI 消息历史翻译为 OpenAI 请求体消息数组。 */
function toOpenAiMessages(options: GenerateOptions): unknown[] {
  const systemParts: string[] = [];
  if (options.system !== undefined && options.system !== '') systemParts.push(options.system);
  for (const message of options.messages) {
    if (message.role === 'system') systemParts.push(flattenText(message));
  }
  const systemText = systemParts.filter(Boolean).join('\n\n');

  const messages: unknown[] = [];
  if (systemText !== '') messages.push({ role: 'system', content: systemText });
  // 历史 assistant tool-call 清洗状态：SenseNova 会对 name/arguments 为空的 tool_call 报 400
  // （invalid tool_call function, function/name/arguments cannot be empty）。
  // 上轮失败产生的空 tool_call 不能原样回放：name 为空的调用直接丢弃（含其孤立 tool-result），
  // arguments 空串补 '{}'，id 空串合成稳定 id 并让对应 tool-result 跟随映射。
  const toolCallIdRemap = new Map<string, string>();
  let syntheticToolCallSeq = 0;
  for (const message of options.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant') {
      const text = flattenText(message);
      const toolCalls = message.content.filter((block): block is ToolCallBlock => block.type === 'tool-call');
      const sanitizedCalls = [];
      for (const call of toolCalls) {
        if (call.name === '' || call.name === undefined) {
          continue; // name 为空的失败 tool_call 丢弃；其 tool-result 因映射不到 id 同步被丢弃
        }
        syntheticToolCallSeq += 1;
        const keptId = call.id !== '' && call.id !== undefined ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
        toolCallIdRemap.set(call.id, keptId);
        sanitizedCalls.push({
          id: keptId,
          type: 'function',
          function: { name: call.name, arguments: call.arguments !== '' && call.arguments !== undefined ? call.arguments : '{}' },
        });
      }
      if (text === '' && sanitizedCalls.length === 0) continue; // 空壳 assistant 消息（content:null 且无 tool_calls）同样会被拒收
      const entry: Record<string, unknown> = { role: 'assistant', content: text !== '' ? text : null };
      if (sanitizedCalls.length > 0) entry.tool_calls = sanitizedCalls;
      messages.push(entry);
      continue;
    }
    // user 角色：文本 + 工具结果（工具结果映射为 role:"tool"）。
    const text = flattenText(message);
    const results = message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result');
    if (text !== '' || results.length === 0) messages.push({ role: 'user', content: text });
    for (const result of results) {
      // 只保留能映射到已回放 tool_call 的结果：丢弃 tool_call 的孤立结果与映射不到的坏历史 id，避免 400。
      const remappedId = toolCallIdRemap.get(result.toolCallId);
      if (remappedId === undefined) continue;
      messages.push({
        role: 'tool',
        tool_call_id: remappedId,
        content: toolResultText(result.content) || '(no output)',
      });
    }
  }
  return messages;
}

/** 组装 OpenAI /chat/completions 请求体。 */
function buildOpenAiBody(options: GenerateOptions): Record<string, unknown> {
  const tools = (options.tools ?? []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: options.model,
    messages: toOpenAiMessages(options),
    stream: true,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {}),
  };
}

/** OpenAI usage → 宿主 TokenUsage（inputTokens 为未缓存输入，缓存读单独计）。 */
function mapUsage(usage: Record<string, unknown>): TokenUsage {
  const prompt = toNumber(usage.prompt_tokens);
  const completion = toNumber(usage.completion_tokens);
  const total = toNumber(usage.total_tokens);
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined;
  const cacheRead = promptDetails !== undefined ? toNumber(promptDetails.cached_tokens) : 0;
  const reasoning = completionDetails !== undefined ? toNumber(completionDetails.reasoning_tokens) : 0;
  return {
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: completion,
    totalTokens: total > 0 ? total : prompt + completion,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** OpenAI finish_reason → 宿主 FinishReason。 */
function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' };
    case 'tool_calls':
    case 'function_call': return { kind: 'tool-calls' };
    case 'length': return { kind: 'max-tokens' };
    case 'aborted': return { kind: 'aborted', failure: { message: 'SenseNova stream aborted', code: 'ABORTED' } };
    default: return { kind: 'stop' };
  }
}

/** 解析一行 SSE；返回解析后的数据对象，`[DONE]` 或空行/注释行返回 undefined。 */
function parseSseDataLine(line: string): unknown {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === '[DONE]') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** SSE 翻译期间的增量组装状态。 */
interface SseState {
  nextIndex: number;
  textIndex: number;
  textContent: string;
  reasoningIndex: number;
  reasoningContent: string;
  toolIndexById: Map<string, number>;
  toolIndexByProtocolIndex: Map<number, number>;
  /** 无 index 且无 id 的退化分片：name → 槽位（name 是工具边界）。 */
  toolIndexByAnonymousName: Map<string, number>;
  /** 最近一次无键续片指向的槽（无 name 续片回退目标）。 */
  lastAnonymousIndex: number;
  toolIdByIndex: Map<number, string>;
  toolNameByIndex: Map<number, string>;
  toolArgsByIndex: Map<number, string>;
  sawContent: boolean;
  pendingUsage: TokenUsage | undefined;
  usageEmitted: boolean;
  finished: boolean;
}

function createSseState(): SseState {
  return {
    nextIndex: 0,
    textIndex: -1,
    textContent: '',
    reasoningIndex: -1,
    reasoningContent: '',
    toolIndexById: new Map(),
    toolIndexByProtocolIndex: new Map(),
    toolIndexByAnonymousName: new Map(),
    lastAnonymousIndex: -1,
    toolIdByIndex: new Map(),
    toolNameByIndex: new Map(),
    toolArgsByIndex: new Map(),
    sawContent: false,
    pendingUsage: undefined,
    usageEmitted: false,
    finished: false,
  };
}

function closeText(state: SseState): StreamChunk[] {
  if (state.textIndex < 0) return [];
  const chunk: StreamChunk = {
    type: 'block-end',
    index: state.textIndex,
    block: { type: 'text', text: state.textContent },
  };
  state.textIndex = -1;
  state.textContent = '';
  return [chunk];
}

function closeReasoning(state: SseState): StreamChunk[] {
  if (state.reasoningIndex < 0) return [];
  const chunk: StreamChunk = {
    type: 'block-end',
    index: state.reasoningIndex,
    block: { type: 'reasoning', text: state.reasoningContent },
  };
  state.reasoningIndex = -1;
  state.reasoningContent = '';
  return [chunk];
}

function closeToolCalls(state: SseState): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [index, args] of [...state.toolArgsByIndex.entries()]) {
    const name = state.toolNameByIndex.get(index) ?? '';
    if (name === '') continue; // name 始终未到达的残缺调用不产出 tool-call block，避免污染历史导致后续 400
    const id = state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`;
    chunks.push({
      type: 'block-end',
      index,
      block: {
        type: 'tool-call',
        id: ToolCallId(id),
        name,
        arguments: args !== '' ? args : '{}',
      },
    });
  }
  state.toolArgsByIndex.clear();
  state.toolIdByIndex.clear();
  state.toolNameByIndex.clear();
  state.toolIndexById.clear();
  state.toolIndexByProtocolIndex.clear();
  state.toolIndexByAnonymousName.clear();
  state.lastAnonymousIndex = -1;
  return chunks;
}

/** 将事件中的 usage 转成单次 usage chunk，避免 finish/trailing 重复发出。 */
function usageChunksFrom(event: unknown, state: SseState): StreamChunk[] {
  if (state.usageEmitted || !isRecord(event)) return [];
  const usageRec = isRecord(event.usage) ? event.usage : undefined;
  if (state.pendingUsage === undefined && usageRec === undefined) return [];
  const usage = state.pendingUsage ?? mapUsage(usageRec as Record<string, unknown>);
  state.pendingUsage = undefined;
  state.usageEmitted = true;
  return [{ type: 'usage', usage }];
}

/** 处理一个 OpenAI SSE 数据对象，返回对应的宿主 StreamChunk 序列。 */
function processChunkEvent(event: unknown, state: SseState): StreamChunk[] {
  if (!isRecord(event)) return [];
  const choices = event.choices;
  if (!Array.isArray(choices)) return usageChunksFrom(event, state);
  const chunks: StreamChunk[] = [];
  for (const rawChoice of choices) {
    if (state.finished) break;
    if (!isRecord(rawChoice)) continue;
    const delta = isRecord(rawChoice.delta) ? rawChoice.delta : undefined;
    const finishReasonRaw = rawChoice.finish_reason;
    const finishReason = typeof finishReasonRaw === 'string' && finishReasonRaw !== '' && finishReasonRaw !== 'null' ? finishReasonRaw : undefined;

    if (delta !== undefined) {
      const content = toString(delta.content) ?? '';
      // 6.8 系使用 reasoning，其他模型使用 reasoning_content；同一事件以前者为优先。
      const reasoning = toString(delta.reasoning_content) ?? toString(delta.reasoning) ?? '';
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : [];

      if (reasoning !== '') {
        chunks.push(...closeText(state));
        if (state.reasoningIndex < 0) {
          state.reasoningIndex = state.nextIndex;
          state.nextIndex += 1;
          chunks.push({ type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' });
        }
        state.reasoningContent += reasoning;
        chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: reasoning });
      }

      if (content !== '') {
        chunks.push(...closeReasoning(state));
        if (state.textIndex < 0) {
          state.textIndex = state.nextIndex;
          state.nextIndex += 1;
          chunks.push({ type: 'block-start', index: state.textIndex, blockType: 'text' });
        }
        state.textContent += content;
        state.sawContent = true;
        chunks.push({ type: 'text-delta', index: state.textIndex, text: content });
      }

      for (const tc of toolCalls) {
        const id = toString(tc.id) ?? '';
        const protocolIndex = typeof tc.index === 'number' && Number.isInteger(tc.index) ? tc.index : undefined;
        const fn = isRecord(tc.function) ? tc.function : undefined;
        const name = fn !== undefined ? (toString(fn.name) ?? '') : '';
        const argsDelta = fn !== undefined ? (toString(fn.arguments) ?? '') : '';
        // OpenAI 规范的 index 优先；非规范响应依次回退到稳定 id、匿名 name。
        let index: number | undefined;
        if (protocolIndex !== undefined) {
          index = state.toolIndexByProtocolIndex.get(protocolIndex);
        } else if (id !== '') {
          index = state.toolIndexById.get(id);
        } else if (name !== '') {
          // name 是匿名分片流的工具边界：同 name 归同槽（可能跨事件续片）。
          index = state.toolIndexByAnonymousName.get(name);
        } else {
          // 纯 arguments 续片：无 name 无法标识工具，续最近匿名槽（防御性，
          // 真实网关不会发既无 index/id 也无 name 的分片流）。
          index = state.lastAnonymousIndex >= 0 ? state.lastAnonymousIndex : undefined;
        }
        if (index === undefined) {
          chunks.push(...closeText(state), ...closeReasoning(state));
          index = state.nextIndex;
          state.nextIndex += 1;
          if (protocolIndex !== undefined) state.toolIndexByProtocolIndex.set(protocolIndex, index);
          if (id !== '') state.toolIndexById.set(id, index);
          if (name !== '' && protocolIndex === undefined && id === '') {
            state.toolIndexByAnonymousName.set(name, index);
            state.lastAnonymousIndex = index;
          }
          state.toolIdByIndex.set(index, id);
          state.toolNameByIndex.set(index, name);
          state.toolArgsByIndex.set(index, '');
          chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
          state.sawContent = true;
        }
        if (id !== '') {
          state.toolIdByIndex.set(index, id);
          state.toolIndexById.set(id, index);
        }
        if (name !== '') state.toolNameByIndex.set(index, name);
        if (protocolIndex === undefined && id === '' && name !== '') {
          state.toolIndexByAnonymousName.set(name, index);
          state.lastAnonymousIndex = index;
        }
        const accumulated = (state.toolArgsByIndex.get(index) ?? '') + argsDelta;
        state.toolArgsByIndex.set(index, accumulated);
        const effectiveName = state.toolNameByIndex.get(index) ?? '';
        chunks.push({
          type: 'tool-call-delta',
          index,
          id: ToolCallId(state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`),
          ...(effectiveName !== '' ? { name: effectiveName } : {}),
          argumentsDelta: argsDelta,
        });
      }
    }

    if (finishReason !== undefined) {
      state.finished = true;
      chunks.push(...closeText(state), ...closeReasoning(state), ...closeToolCalls(state));
      chunks.push(...usageChunksFrom(event, state));
      chunks.push({ type: 'finish', reason: mapFinishReason(finishReason) });
      continue;
    }

    const usageRec = isRecord(event.usage) ? event.usage : undefined;
    if (usageRec !== undefined && state.pendingUsage === undefined) {
      state.pendingUsage = mapUsage(usageRec);
    }
  }
  return chunks;
}

/** 把 OpenAI SSE 响应体翻译为宿主 StreamChunk 序列。 */
async function* parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = createSseState();
  let buffer = '';
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseSseDataLine(line);
        if (event === undefined) continue;
        if (finished) {
          for (const chunk of usageChunksFrom(event, state)) yield chunk;
          continue;
        }
        for (const chunk of processChunkEvent(event, state)) {
          yield chunk;
          if (chunk.type === 'finish') finished = true;
        }
      }
    }
    if (buffer.trim() !== '') {
      const event = parseSseDataLine(buffer);
      if (event !== undefined) {
        if (finished) {
          for (const chunk of usageChunksFrom(event, state)) yield chunk;
        } else {
          for (const chunk of processChunkEvent(event, state)) {
            yield chunk;
            if (chunk.type === 'finish') finished = true;
          }
        }
      }
    }
    if (!finished) {
      const trailing = [...closeText(state), ...closeReasoning(state), ...closeToolCalls(state)];
      for (const chunk of trailing) yield chunk;
      if (!state.sawContent) {
        throw new LlmError('llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复', 'EMPTY_RESPONSE');
      }
      if (state.pendingUsage !== undefined) yield { type: 'usage', usage: state.pendingUsage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  } catch (error) {
    if (signal?.aborted || error instanceof LlmError) throw error;
    throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, 'TRANSPORT', { cause: error });
  } finally {
    await reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
}

/** 判断错误文本是否为「模型不可路由」的 404 措辞。 */
function isModelNotFoundText(errText: string): boolean {
  const lower = errText.toLowerCase();
  return lower.includes('model route not found') || lower.includes('model is not found');
}

/** 把预流 HTTP 失败映射为稳定 LlmError。 */
function httpError(status: number, errText: string, retryAfterMs: number | undefined): LlmError {
  if (status === 401) {
    return new LlmError(
      'llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效',
      'INVALID_CREDENTIAL',
      { status: 401 },
    );
  }
  if (status === 404 && isModelNotFoundText(errText)) {
    return new LlmError(
      'llm-sensenova: SenseNova model is not routable — the model id is no longer served；SenseNova 模型不可路由：该模型 id 已下线',
      MODEL_NOT_FOUND_CODE,
      { status: 404 },
    );
  }
  if (status === 429) {
    // SenseNova 429 属渠道常态性 RPM 瞬时超限：不轮换 key（保护按 key 命中的 prompt 缓存）、
    // 不冷却账号。超长 Retry-After（> 3000ms）整值不透传 providerRetryAfterMs（也不截断），
    // 由宿主本地退避策略计算；<= 3000ms 才透传。
    const cappedRetryAfterMs = retryAfterMs !== undefined && retryAfterMs > 0 && retryAfterMs <= PROVIDER_RETRY_AFTER_CAP_MS
      ? retryAfterMs
      : undefined;
    return new LlmError('llm-sensenova: SenseNova API error 429 — rate limited；SenseNova API 返回 429：请求被限流', 'RATE_LIMIT', {
      status: 429,
      ...(cappedRetryAfterMs !== undefined ? { providerRetryAfterMs: cappedRetryAfterMs } : {}),
    });
  }
  return new LlmError(`llm-sensenova: SenseNova API error ${status}: ${errText.slice(0, 500)}`, 'PROVIDER_HTTP_ERROR', { status });
}

/** SenseNova（OpenAI 兼容）适配器。 */
export class SensenovaAdapter extends LlmAdapter {
  private readonly deps: SensenovaAdapterDeps;
  private readonly fetchImpl: typeof fetch;
  private catalog: CatalogEntry[] = [];
  /** 进程内失败缓存：运行时返回 MODEL_NOT_FOUND 的模型 id，直到适配器生命周期结束。 */
  private readonly failedModels = new Set<string>();

  constructor(deps: SensenovaAdapterDeps) {
    super();
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'SenseNova' };
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return resolveRetryPolicy(
      {
        mode: 'normal',
        maxRetries: 1000,
        backoff: { maxDelayMs: PROVIDER_RETRY_AFTER_CAP_MS },
      },
      'llm-sensenova.retryPolicy',
    );
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.deps.options();
    let apiKey: string;
    try {
      apiKey = await this.deps.resolveApiKey(connection);
    } catch {
      return [];
    }
    const response = await this.fetchImpl(`${connection.apiBase}/models`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...attributionHeaders(),
      },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (response.status === 401) {
      throw new LlmError('llm-sensenova: SenseNova API rejected the API key (401)', 'INVALID_CREDENTIAL', { status: 401 });
    }
    if (!response.ok) {
      throw new LlmError(`llm-sensenova: models endpoint returned HTTP ${response.status}`, 'PROVIDER_HTTP_ERROR', { status: response.status });
    }
    const parsed: unknown = await response.json();
    // 以新快照原子替换缓存（保留失败标记），避免 listModels 新目录与 resolveModel 旧能力不一致。
    const models = parseCatalog(parsed, this.failedModels, connection.modelSelection ?? EMPTY_MODEL_SELECTION);
    this.catalog = models;
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
    }));
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = this.catalog.find((m) => m.id === model);
    // SenseNova 目录若无上下文字段，用 131072 作为合理默认（见顶部常量注释）。
    const contextWindow = entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    return {
      provider,
      id: model,
      name: entry?.name ?? displayNameFor(model),
      inputModalities: entry?.inputModalities ?? ['text'],
      context: { contextWindow },
      ...(entry?.maxOutputTokens !== undefined ? { defaultMaxTokens: entry.maxOutputTokens } : {}),
      ...(entry?.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.deps.options();
    const body = JSON.stringify(buildOpenAiBody(options));
    const tried = new Set<string>();
    let apiKey = await this.deps.resolveApiKey(connection);
    let response: Response | undefined;

    for (let rotations = 0; ; ) {
      tried.add(apiKey);
      let attempt: Response;
      try {
        attempt = await this.fetchImpl(`${connection.apiBase}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            ...attributionHeaders(),
          },
          body,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new LlmError(`llm-sensenova: request to ${connection.apiBase} failed: ${errorChain(error)}；连接 SenseNova API 失败，通常是网络或代理问题`, 'TRANSPORT', { cause: error });
      }
      if (attempt.ok) {
        response = attempt;
        break;
      }
      const errText = await attempt.text().catch(() => '');
      const retryAfterMs = parseRetryAfterMs(attempt.headers.get('retry-after'));
      // 404 模型不可路由：标记失败且不轮换/不重试。
      const modelNotFound = attempt.status === 404 && isModelNotFoundText(errText);
      if (modelNotFound) {
        this.failedModels.add(options.model);
        throw httpError(attempt.status, errText, retryAfterMs);
      }
      // 429：SenseNova 渠道常态性 RPM 瞬时超限，不代表账号被封。不轮换 key
      // （一个会话固定使用一个 key，轮换会破坏服务端按 key 命中的 prompt 缓存）、
      // 也不做账号冷却，直接抛 RATE_LIMIT 交给宿主重试层自动退避后原 key 重试。
      const rotatable = attempt.status === 401;
      if (rotatable && options.signal?.aborted !== true && rotations < connection.accountCount) {
        rotations += 1;
        const next = await this.deps.rotateApiKey(
          apiKey,
          'invalid-credential',
        );
        if (next !== undefined && !tried.has(next)) {
          apiKey = next;
          continue;
        }
      }
      throw httpError(attempt.status, errText, retryAfterMs);
    }

    if (response === undefined) {
      // 不可达：循环要么 break（成功）要么 throw；仅用于满足明确赋值分析。
      throw new LlmError('llm-sensenova: SenseNova API returned no response', 'PROVIDER_PROTOCOL_ERROR');
    }
    if (response.body === null) {
      throw new LlmError('llm-sensenova: SenseNova API returned no response body', 'PROVIDER_PROTOCOL_ERROR');
    }
    yield* parseOpenAiSse(response.body, options.signal);
  }
}
