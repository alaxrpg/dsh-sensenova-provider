/** Chat Completions 请求体构造（自 src/adapter.ts 迁出，行为不变；
 * make-responses-default-wire-protocol 4.1）。
 *
 * 含 align-request-fields-with-docs 的字段分派（ChatFieldPlan）与坏历史
 * tool_call 四防御（空 name 丢弃 / arguments 补 '{}' / 空 id 合成稳定 id /
 * 孤立 tool-result 丢弃）。
 * @module dsh-sensenova-provider/wire/body-chat
 */
import type {
  ContentBlock,
  GenerateOptions,
  ReasoningEffortId,
  ToolCallBlock,
} from '@deepseek-ai/dsh-llm';
import { factsFor, staticFacts } from './facts.ts';
import { translateUserContent, type PreparedImage } from './blocks.ts';
import type { FactsCatalogEntry } from './types.ts';

/** 目录条目的 Chat 侧输入（adapter CatalogEntry 的结构子集，避免循环依赖）。 */
export interface ChatCatalogEntry {
  reasoning?: { efforts: readonly { id: ReasoningEffortId }[] };
  supportedSamplingParameters?: readonly string[];
}

/** 展平工具结果内容块为纯文本（0.1.7 类型面：tool 结果为独立 role:'tool' 消息）。 */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => block.type === 'text' ? block.text : '')
    .join('');
}

/** 拼出某条消息的可见文本（接受 RequestMessage：含无持久 id 的 RequestUserInput）。 */
function flattenText(message: { content: readonly ContentBlock[] }): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

/** 把 OpenAI 消息历史翻译为 OpenAI 请求体消息数组。
 * replayReasoning（deepseek 系且本轮带 tools）：把宿主历史 assistant 消息里的
 * reasoning 増量重建为 assistant 项的 reasoning_content 回传（文档 :1411-1412、
 * :1790-1791：deepseek 系带 tools 必须回传全部历史思维链；不带 tools 或其余模型
 * 不携带——6.8/glm 多轮不回传，kimi 仅要求原样回传 content+tool_calls）。 */
function toOpenAiMessages(options: GenerateOptions, replayReasoning: boolean, images: Map<string, PreparedImage> | undefined): unknown[] {
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
      const reasoningText = replayReasoning
        ? message.content.filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
        : '';
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
      if (reasoningText !== '') entry.reasoning_content = reasoningText;
      if (sanitizedCalls.length > 0) entry.tool_calls = sanitizedCalls;
      messages.push(entry);
      continue;
    }
    if (message.role === 'tool') {
      // 0.1.7 类型面：工具结果是一等 role:'tool' 消息（toolCallId + content 块），
      // 不再是 user 消息内的 'tool-result' 块。
      // 只保留能映射到已回放 tool_call 的结果：丢弃 tool_call 的孤立结果与映射不到的坏历史 id，避免 400。
      const remappedId = toolCallIdRemap.get(message.toolCallId);
      if (remappedId === undefined) continue;
      messages.push({
        role: 'tool',
        tool_call_id: remappedId,
        content: toolResultText(message.content) || '(no output)',
      });
      continue;
    }
    // user 角色：无图像保持纯文本现状；有图像经 blocks.ts 翻译为对象数组
    // （add-multimodal-input 1.3：图像不再被静默丢弃）。
    const content = translateUserContent(message.content, 'chat-completions', images);
    if (typeof content === 'string') {
      if (content !== '') messages.push({ role: 'user', content });
    } else if (content.length > 0) {
      messages.push({ role: 'user', content });
    }
  }
  return messages;
}

/** Chat 请求体字段分派计划（align-request-fields-with-docs design D4/D5，
 * 依据模型 id 与目录条目计算；目录条目缺失时仅用静态表）。 */
interface ChatFieldPlan {
  /** 输出上限字段名：kimi-k3 用 max_completion_tokens（:2446），其余 max_tokens。 */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** 流式请求显式发送 stream_options:{include_usage:true}：
   * 6.8(:551)/deepseek-v4-flash(:1327)/deepseek-flash(:1703)/kimi-k3(:2443) 默认 true，
   * glm-5.2 参数表无此字段（:2022 起）不发。 */
  streamOptionsUsage: boolean;
  /** deepseek 系（v4-flash/deepseek-flash）且本轮带 tools：回放全部历史思维链。 */
  replayReasoningWithTools: boolean;
  /** 出站永不发送的采样字段（kimi-k3 参数表标注 temperature/top_p 固定值、
   * frequency/presence_penalty 固定 0「建议不要传入」，:2440-2444）。 */
  blockedSampling: ReadonlySet<string>;
  /** effort 兼容映射（仅 deepseek-flash）。 */
  effortCompat: Readonly<Record<string, string>> | undefined;
  /** 已知 effort 值域（静态表或目录词表）；未知模型 undefined（无从判定则原样发送）。 */
  effortDomain: readonly string[] | undefined;
  /** kimi-k3 特例：effort none → thinking:"disabled" + 不发 reasoning_effort。
   * 前提假设（design Risks）：文档 §八·1 对 kimi none 自相矛盾，按 thinking 可关落地，待实测修正。 */
  noneMapsToThinkingDisabled: boolean;
}

/** 计算模型的 Chat 字段分派计划（add-model-facts 2.2：数据驱动自 wire/facts，
 * 出站行为与迁移前逐字段一致；未知模型沿用「保守不发/原样 effort」语义）。 */
function chatFieldPlan(model: string, entry: ChatCatalogEntry | undefined): ChatFieldPlan {
  // ChatCatalogEntry 是 adapter CatalogEntry 的结构子集；factsFor 只读取
  // maxOutputTokens/supportedSamplingParameters/inputModalities 等可选字段， widening 安全。
  const facts = factsFor(model, entry as FactsCatalogEntry | undefined);
  const catalogEfforts = entry?.reasoning?.efforts.map((effort) => effort.id as string);
  // 未知模型 efforts 为空数组：无从判定值域 → 视同 undefined（原样发送，迁移前语义）。
  const staticDomain = facts.efforts.length > 0 ? facts.efforts : undefined;
  return {
    maxTokensField: facts.outputLimitField,
    streamOptionsUsage: facts.supportsStreamOptions,
    replayReasoningWithTools: facts.requiresReasoningReplay,
    blockedSampling: new Set(facts.blockedSampling),
    effortCompat: facts.effortCompat,
    effortDomain: catalogEfforts ?? staticDomain,
    noneMapsToThinkingDisabled: facts.noneMapsToThinkingDisabled,
    // 注：glm-5.2 不发 thinking——本适配器从不构造 thinking 字段，glm 的 none 经
    // reasoning_effort:"none" 表达（glm thinking 不支持 disabled，:2143）。
  };
}

/** 组装 OpenAI /chat/completions 请求体（按 ChatFieldPlan 分派字段）。
 * images：blocks.ts 预解析的图像载荷（add-multimodal-input）；缺省 undefined 时
 * user 内容保持纯文本现状（零回归）。 */
export function buildChatBody(
  options: GenerateOptions,
  entry: ChatCatalogEntry | undefined,
  images?: Map<string, PreparedImage> | undefined,
): Record<string, unknown> {
  const model = options.model;
  const plan = chatFieldPlan(model, entry);
  const tools = (options.tools ?? []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const messages = toOpenAiMessages(options, plan.replayReasoningWithTools && tools.length > 0, images);

  // 采样字段白名单：目录 supported_sampling_parameters 优先，缺失时静态兜底；
  // 白名单存在的字段未列出即不发（当前透传面为 temperature；seed/n 等
  // GenerateOptions 暂不透传，兜底表为后续接入预留）。
  const samplingWhitelist = entry?.supportedSamplingParameters ?? staticFacts(model)?.samplingParameters;
  const samplingAllowed = (field: string, blocked: boolean): boolean => {
    if (blocked) return false;
    if (samplingWhitelist === undefined) return true;
    return samplingWhitelist.includes(field);
  };

  // reasoning_effort 出站策略（design D5）：值域内原样；命中兼容映射改写；
  // 均不在（含 kimi none 特例）不发送未知值。
  let reasoningEffortWire: string | undefined;
  let thinkingDisabled = false;
  if (options.reasoningEffort !== undefined) {
    const effort = options.reasoningEffort as string;
    if (plan.noneMapsToThinkingDisabled && effort === 'none') {
      thinkingDisabled = true; // kimi-k3：不发 reasoning_effort，改发 thinking:"disabled"（待实测修正）
    } else {
      const mapped = plan.effortCompat?.[effort];
      const inDomain = plan.effortDomain?.includes(effort) ?? true;
      reasoningEffortWire = mapped !== undefined
        ? mapped
        : inDomain
          ? effort
          : undefined;
    }
  }

  return {
    model,
    messages,
    stream: true,
    ...(options.temperature !== undefined && samplingAllowed('temperature', plan.blockedSampling.has('temperature'))
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens !== undefined ? { [plan.maxTokensField]: options.maxTokens } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(plan.streamOptionsUsage ? { stream_options: { include_usage: true } } : {}),
    ...(reasoningEffortWire !== undefined ? { reasoning_effort: reasoningEffortWire } : {}),
    ...(thinkingDisabled ? { thinking: 'disabled' } : {}),
  };
}
