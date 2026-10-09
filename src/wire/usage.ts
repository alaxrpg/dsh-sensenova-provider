/** Responses usage → 宿主 TokenUsage（make-responses-default-wire-protocol 3.4）。
 *
 * 字段名映射（§6.7）：input_tokens/output_tokens/total_tokens 直取；
 * input_tokens_details.cached_tokens → cacheReadTokens；
 * output_tokens_details.reasoning_tokens → reasoningTokens。
 *
 * TODO（实测点，design §八·11）：Responses input_tokens 是否已含 cached_tokens
 * 未知。初版按「直取」处理（spec scenario 措辞）；若实测发现 input_tokens 为
 * 未缓存口径之外的值，需在此改为 input_tokens - cached_tokens 对齐宿主
 * inputTokens 的「未缓存输入」语义。
 * @module dsh-sensenova-provider/wire/usage
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 把 Responses 事件携带的 usage 对象映射为宿主 TokenUsage。 */
export function mapResponsesUsage(usage: Record<string, unknown>): TokenUsage {
  const input = toNumber(usage.input_tokens);
  const output = toNumber(usage.output_tokens);
  const total = toNumber(usage.total_tokens);
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  const cacheRead = inputDetails !== undefined ? toNumber(inputDetails.cached_tokens) : 0;
  const reasoning = outputDetails !== undefined ? toNumber(outputDetails.reasoning_tokens) : 0;
  // 直取口径（见模块注释 TODO 实测点）。
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total > 0 ? total : input + output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}
