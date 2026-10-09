/**
 * dsh-sensenova-provider — DeepSeek Harness 的 SenseNova（OpenAI 兼容）LLM
 * provider 插件（host 侧）。
 *
 * 注册 `sensenova` 路由并声明为可配置 provider（显示名 SenseNova），在 Models
 * 页提供卡片；设置段挂在 `llm-sensenova` 命名空间下，支持共享 `apiBase` 下
 * 的默认账号 + 多账号列表 + 手动钉选（activeAccount）。key 一律通过宿主
 * 凭据服务解析（环境变量兜底），原文不落日志。
 *
 * ```yaml
 * - id: llm-sensenova
 *   name: "@alaxrpg/dsh-sensenova-provider"
 *   config:
 *     apiKeyEnv: SENSENOVA_API_KEY
 * ```
 *
 * `name` 必须是完整包名（加载器按真实包名从 node_modules 解析）；YAML 中以
 * `@` 开头的标量必须加引号。
 *
 * @module dsh-sensenova-provider
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-settings';
import { LlmError, assertUsableApiKey } from '@deepseek-ai/dsh-llm';
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { SensenovaAccountPool, type AccountSlot } from './accounts.ts';
import { SensenovaAdapter } from './adapter.ts';
import type { WireProtocol } from './wire/plan.ts';
import type { ReasoningSummary } from './wire/body-responses.ts';

export const name = 'llm-sensenova';
// 模型目录首次加载依赖凭据服务；声明依赖避免 host 启动竞态把已配置账户看成无 key。
export const inject: string[] = ['llm', 'credentials'];
const NS = 'llm-sensenova';
const PROVIDER = 'sensenova';
export const DEFAULT_API_KEY_ENV = 'SENSENOVA_API_KEY';
export const DEFAULT_API_BASE = 'https://token.sensenova.cn/v1';

/** 一个额外账户（settings 数组元素）。apiKeyEnv 为 credential-ref。 */
export interface SensenovaAccountConfig {
  id?: string;
  label?: string;
  apiKeyEnv?: string;
}

/** 0.1.7-rc.2 起 volatile 配置字段以稳定引用（{ get() }）形式注入；兼容程序化构造的普通值。 */
type VolatileLike = { get(): unknown };

function snap<T>(value: T | VolatileLike): T {
  const unwrapped = typeof value === 'object' && value !== null && typeof (value as VolatileLike).get === 'function'
    ? (value as VolatileLike).get()
    : value;
  return unwrapped as T;
}

/** 插件配置（schemastery schema 的输出形状，所有字段均可选；volatile 字段可为稳定引用）。 */
export interface SensenovaConfig {
  apiKeyEnv?: string | VolatileLike;
  apiBase?: string | VolatileLike;
  accounts?: SensenovaAccountConfig[] | VolatileLike;
  activeAccount?: string | VolatileLike;
  /** 每 key 并发生成请求上限（正整数，默认 1）。 */
  concurrency?: number | VolatileLike;
  /** 配额类 429 粘性换 key（design D5，默认关；401 行为不变，任何 429 不冷却账号）。 */
  quotaRotation?: boolean | VolatileLike;
  /** wire 协议模式（缺省 auto：优先 Responses，决策表降级 Chat）。 */
  wireProtocol?: WireProtocol | VolatileLike;
  /** Responses 推理摘要（缺省 auto）。 */
  reasoningSummary?: ReasoningSummary | VolatileLike;
}

// volatile 字段的 schema 输入/输出类型与手工声明形状存在 exactOptionalPropertyTypes 下的
// 结构差异，这里以显式断言固定公开类型（运行时形状不变）。
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  apiBase: z.string().default(DEFAULT_API_BASE).volatile(),
  accounts: z.array(z.object({
    id: z.string().default(''),
    label: z.string().default(''),
    apiKeyEnv: z.string().role('credential-ref').default(''),
  })).default([]).volatile(),
  activeAccount: z.string().default('').volatile(),
  concurrency: z.natural().min(1).default(1).volatile(),
  // 高级设置：「配额类 429 换 key」，默认关（design D5：尊重既有「429 不换 key」决策）。
  quotaRotation: z.boolean().default(false).volatile(),
  // wire 协议模式（make-responses-default-wire-protocol §5.1；缺省 auto）。
  wireProtocol: z.union([z.const('auto'), z.const('responses'), z.const('chat-completions')]).default('auto').volatile(),
  // Responses 推理摘要（reasoning.summary；缺省 auto）。
  reasoningSummary: z.union([z.const('auto'), z.const('concise'), z.const('detailed')]).default('auto').volatile(),
}) as unknown as z<SensenovaConfig>;

/** 一个解析后的账户槽位：id/label + 合法 credential-ref 名。 */
export interface ResolvedAccountSpec {
  id: string;
  label: string;
  /** 合法 credential-ref 名；非法输入不会保留原文。 */
  ref: string;
  /** 为兼容公开类型保留；当前解析路径始终为 false，不承载字面密钥。 */
  isLiteral: boolean;
}

/** resolveAdapterOptions 的输出：连接事实 + 账户槽位。 */
export interface ResolvedSensenovaOptions {
  apiBase: string;
  activeAccount: string;
  accounts: ResolvedAccountSpec[];
  concurrency: number;
  /** 配额类 429 粘性换 key（默认 false）。 */
  quotaRotation: boolean;
  /** wire 协议模式（默认 auto）。 */
  wireProtocol: WireProtocol;
  /** Responses 推理摘要（默认 auto）。 */
  reasoningSummary: ReasoningSummary;
}

/** 把 wire 协议配置归一化为三值枚举（非法输入回退 auto）。 */
export function normalizeWireProtocol(value: unknown): WireProtocol {
  return value === 'responses' || value === 'chat-completions' ? value : 'auto';
}

/** 把推理摘要配置归一化为三值枚举（非法输入回退 auto）。 */
export function normalizeReasoningSummary(value: unknown): ReasoningSummary {
  return value === 'concise' || value === 'detailed' ? value : 'auto';
}

/** 把配置的并发上限归一化为正整数（非正整数/无法解析回退 1）。 */
export function normalizeConcurrency(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

function resolveSlot(id: string, label: string, value: string): ResolvedAccountSpec {
  // 只接受 credential-ref；非法输入不保留原文，也不作为字面 API key 使用。
  const ref = typeof value === 'string' ? value.trim() : '';
  return isCredentialRefName(ref)
    ? { id, label, ref, isLiteral: false }
    : { id, label, ref: '', isLiteral: false };
}

/**
 * 从原始 config 到解析后连接事实的唯一显式步骤。程序化构造可能绕过
 * Schemastery 归一化，因此每个默认值在此重新判定——既用于加载时的组合配置，
 * 也用于 settings 快照首次使用。
 */
export function resolveAdapterOptions(config: SensenovaConfig): ResolvedSensenovaOptions {
  // volatile 字段先解引用再判定（兼容普通值与稳定引用两种构造路径）。
  const apiKeyEnvRaw = snap(config.apiKeyEnv);
  const apiBaseRaw = snap(config.apiBase);
  const accountsRaw = snap(config.accounts) ?? [];
  const activeAccountRaw = snap(config.activeAccount);
  const accounts: ResolvedAccountSpec[] = [];
  const defaultEnv = typeof apiKeyEnvRaw === 'string' && apiKeyEnvRaw.trim() !== ''
    ? apiKeyEnvRaw.trim()
    : DEFAULT_API_KEY_ENV;
  accounts.push(resolveSlot('default', 'Default', defaultEnv));
  for (const [index, account] of accountsRaw.entries()) {
    if (account === undefined) continue;
    const refName = typeof account.apiKeyEnv === 'string' && account.apiKeyEnv.trim() !== '' ? account.apiKeyEnv.trim() : undefined;
    if (refName === undefined) continue;
    const id = typeof account.id === 'string' && account.id.trim() !== '' ? account.id.trim() : `account-${index + 2}`;
    const label = typeof account.label === 'string' && account.label.trim() !== '' ? account.label.trim() : `Account ${index + 2}`;
    accounts.push(resolveSlot(id, label, refName));
  }
  return {
    apiBase: typeof apiBaseRaw === 'string' && apiBaseRaw.trim() !== ''
      ? apiBaseRaw.trim()
      : DEFAULT_API_BASE,
    activeAccount: typeof activeAccountRaw === 'string' ? activeAccountRaw : '',
    accounts,
    concurrency: normalizeConcurrency(snap(config.concurrency)),
    // 防御非布尔输入（程序化构造可能绕过 Schemastery 归一化）。
    quotaRotation: snap(config.quotaRotation) === true,
    wireProtocol: normalizeWireProtocol(snap(config.wireProtocol)),
    reasoningSummary: normalizeReasoningSummary(snap(config.reasoningSummary)),
  };
}

export function apply(ctx: Context, config: SensenovaConfig): void {
  // 0.1.7-rc.2 起 Settings 从插件 Config schema（volatile 字段）自动派生表单，
  // 不再有 installSection；volatile 引用快照可能原地更新，故每次调用都重解析，
  // 不做引用相等性缓存（resolveAdapterOptions 开销极小）。
  const current = () => config;
  const options = (): ResolvedSensenovaOptions => resolveAdapterOptions(current());

  const resolveRef = async (spec: ResolvedAccountSpec): Promise<string | undefined> => {
    // 防御性校验：即使外部构造了 isLiteral=true，也不得让 ref 原文进入请求。
    if (spec.isLiteral || !isCredentialRefName(spec.ref)) return undefined;
    const ref = credentialRef(spec.ref);
    // 允许从已注册但尚未完成当前 fiber 激活态的 host 凭据服务读取；
    // 依赖声明负责启动顺序，strict=false 兼容远端 host 的服务包装层。
    const credentials = ctx.get('credentials', false);
    let credentialInfo: { configured: boolean; source?: string; writable: boolean } | undefined;
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(ref);
      if (resolved !== undefined && resolved.value !== undefined && resolved.value !== '') return resolved.value;
      // `describe()` is metadata-only: it never returns the secret. Use it to
      // distinguish an actually absent ref from a stored-but-unresolvable entry.
      credentialInfo = await credentials.describe(ref);
    }
    const ambient = launchEnvironmentOf(ctx).get(spec.ref);
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value;
    if (credentialInfo?.configured === true) {
      throw new LlmError(
        `llm-sensenova: credential reference "${spec.ref}" is marked configured but resolved no usable value (source ${credentialInfo.source ?? 'unknown'}, writable ${credentialInfo.writable}); clear and re-save it through the credentials service`,
        'INVALID_CREDENTIAL',
      );
    }
    return undefined;
  };

  const slots = (): readonly AccountSlot[] => options().accounts.map((spec) => ({
    id: spec.id,
    label: spec.label,
    resolveKey: () => resolveRef(spec),
  }));

  const preferredId = (): string | undefined => {
    const active = options().activeAccount;
    return active !== '' ? active : undefined;
  };

  const pool = new SensenovaAccountPool({ slots, preferredId });

  const resolveApiKey = async (connection: { apiBase: string; accountCount: number }): Promise<string> => {
    const resolved = await pool.resolveKey();
    if (resolved !== undefined) {
      return assertUsableApiKey(resolved.key, 'llm-sensenova', resolved.slot.label);
    }
    throw new LlmError(
      `llm-sensenova: no API key for provider route "${PROVIDER}" (apiBase ${connection.apiBase}); store a key through the credentials service or settings；未配置 SenseNova API 密钥，请在设置页或凭据页配置`,
      'MISSING_CREDENTIAL',
    );
  };

  const rotateApiKey = async (
    rejectedKey: string,
    rejection: 'invalid-credential' | 'quota-exhausted',
  ): Promise<string | undefined> => {
    // 'invalid-credential'（401）永久禁用被拒账号；'quota-exhausted'（配额类 429）
    // 不写任何账号状态，仅用于选取下一把可用 key（design D5）。
    pool.markRejected(rejectedKey, rejection);
    const resolved = await pool.resolveKey({ exclude: rejectedKey });
    if (resolved === undefined) return undefined;
    return assertUsableApiKey(resolved.key, 'llm-sensenova', resolved.slot.label);
  };

  const adapter = new SensenovaAdapter({
    options: () => {
      const resolved = options();
      return {
        apiBase: resolved.apiBase,
        accountCount: resolved.accounts.length,
        concurrency: resolved.concurrency,
        quotaRotation: resolved.quotaRotation,
        wireProtocol: resolved.wireProtocol,
        reasoningSummary: resolved.reasoningSummary,
      };
    },
    resolveApiKey,
    rotateApiKey,
  });

  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'SenseNova',
    settingsNs: NS,
    settingsPath: [],
  }]);

  ctx.llm.registerAdapter([PROVIDER], adapter);
}
