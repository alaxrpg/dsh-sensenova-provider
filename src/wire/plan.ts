/** wire 协议决策（make-responses-default-wire-protocol；docs/sensenova-upgrade-plan.md §五）。
 *
 * §5.2 判定表四条降级 + 「省略优于传无效值」：
 * - stop 非空 / 模型不支持 Responses / effort 偏离 Responses 默认档（非 none）/
 *   运行时 400 标记（§5.3 responsesUnsupported）→ 降级 Chat Completions。
 * - effort === none → Responses 显式发 reasoning:{effort:"none"}（真关闭）。
 * - effort === responsesDefaultEffort 或未选 → Responses 不发 reasoning（默认即所需）。
 * - `responses` 强制模式命中任一降级条件 → 抛错并说明切换方法（不静默回退）。
 * @module dsh-sensenova-provider/wire/plan
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { ModelFacts, WireKind } from './types.ts';

/** 插件配置的三种 wire 模式（缺省 auto：优先 Responses，语义会丢失时才降级）。 */
export type WireProtocol = 'auto' | 'responses' | 'chat-completions';

/** 决策结果附带的原因标识（供日志与测试断言）。 */
export type WireReason =
  | 'responses-default'
  | 'forced-responses'
  | 'forced-chat'
  | 'downgrade-stop'
  | 'downgrade-unsupported-model'
  | 'downgrade-effort'
  | 'downgrade-runtime-marked';

export interface WirePlan {
  wire: WireKind;
  reason: WireReason;
}

/** resolveWirePlan 的配置侧输入（SensenovaConnection 的 wire 相关字段子集）。 */
export interface WirePlanConfig {
  wireProtocol?: WireProtocol;
}

/** 命中降级时的判定（未命中为 undefined）。 */
function degradeReason(
  options: GenerateOptions,
  facts: ModelFacts,
  responsesUnsupported: ReadonlySet<string>,
): WireReason | undefined {
  if (options.stop !== undefined && options.stop.length > 0) return 'downgrade-stop';
  if (!facts.supportedWires.includes('responses')) return 'downgrade-unsupported-model';
  const effort = options.reasoningEffort as string | undefined;
  if (effort !== undefined && effort !== 'none' && effort !== facts.responsesDefaultEffort) {
    return 'downgrade-effort';
  }
  if (responsesUnsupported.has(options.model)) return 'downgrade-runtime-marked';
  return undefined;
}

/**
 * 决定本次请求使用的 wire（§5.2 四条降级判定，序即优先级）。
 * `responses` 强制模式命中降级条件时抛 LlmError，消息说明如何切换到 auto 或
 * chat-completions（spec「强制 Responses 报错」场景）。
 */
export function resolveWirePlan(
  options: GenerateOptions,
  config: WirePlanConfig,
  facts: ModelFacts,
  responsesUnsupported: ReadonlySet<string>,
): WirePlan {
  const protocol: WireProtocol = config.wireProtocol ?? 'auto';
  if (protocol === 'chat-completions') return { wire: 'chat-completions', reason: 'forced-chat' };
  const degrade = degradeReason(options, facts, responsesUnsupported);
  if (degrade !== undefined) {
    if (protocol === 'responses') {
      throw new LlmError(
        `llm-sensenova: wireProtocol "responses" cannot serve this request (${degrade})；当前请求在强制 Responses 模式下无法保真（${degrade}），请在设置中将 wireProtocol 切换为 "auto"（自动降级 Chat Completions）或 "chat-completions"`,
        'INVALID_REQUEST',
      );
    }
    return { wire: 'chat-completions', reason: degrade };
  }
  return { wire: 'responses', reason: protocol === 'responses' ? 'forced-responses' : 'responses-default' };
}
