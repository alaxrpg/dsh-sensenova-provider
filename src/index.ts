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
import { SensenovaAdapter, type ModelSelection } from './adapter.ts';

export const name = 'llm-sensenova';
export const inject: string[] = ['llm'];
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

/** 插件配置（schemastery schema 的输出形状，所有字段均可选）。 */
export interface SensenovaConfig {
  apiKeyEnv?: string;
  apiBase?: string;
  accounts?: SensenovaAccountConfig[];
  activeAccount?: string;
  modelSelection?: { include?: string[]; exclude?: string[] };
}

export const Config: z<SensenovaConfig> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  apiBase: z.string().default(DEFAULT_API_BASE),
  accounts: z.array(z.object({
    id: z.string().default(''),
    label: z.string().default(''),
    apiKeyEnv: z.string().role('credential-ref').default(''),
  })).default([]),
  activeAccount: z.string().default(''),
  modelSelection: z.object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
  }),
});

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
  modelSelection?: ModelSelection;
}

/** 领域层规范化模型 id：去除首尾空白、过滤空项、稳定去重。 */
function normalizeModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 规范化用户模型选择配置；未配置时保持 undefined，便于 settings unset。 */
export function normalizeModelSelection(
  selection: SensenovaConfig['modelSelection'],
): ModelSelection | undefined {
  if (selection === undefined || selection === null || typeof selection !== 'object') return undefined;
  return {
    include: normalizeModelIds(selection.include),
    exclude: normalizeModelIds(selection.exclude),
  };
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
  const accounts: ResolvedAccountSpec[] = [];
  const defaultEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  accounts.push(resolveSlot('default', 'Default', defaultEnv));
  for (const [index, account] of (config.accounts ?? []).entries()) {
    if (account === undefined) continue;
    const refName = typeof account.apiKeyEnv === 'string' && account.apiKeyEnv.trim() !== '' ? account.apiKeyEnv.trim() : undefined;
    if (refName === undefined) continue;
    const id = typeof account.id === 'string' && account.id.trim() !== '' ? account.id.trim() : `account-${index + 2}`;
    const label = typeof account.label === 'string' && account.label.trim() !== '' ? account.label.trim() : `Account ${index + 2}`;
    accounts.push(resolveSlot(id, label, refName));
  }
  const modelSelection = normalizeModelSelection(config.modelSelection);
  return {
    apiBase: config.apiBase ?? DEFAULT_API_BASE,
    activeAccount: typeof config.activeAccount === 'string' ? config.activeAccount : '',
    accounts,
    ...(modelSelection !== undefined ? { modelSelection } : {}),
  };
}

export function apply(ctx: Context, config: SensenovaConfig): void {
  let current = () => config;
  let lastRaw: SensenovaConfig | undefined;
  let lastGood: ResolvedSensenovaOptions | undefined;

  const options = (): ResolvedSensenovaOptions => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    const next = resolveAdapterOptions(raw);
    lastRaw = raw;
    lastGood = next;
    return next;
  };
  options();

  const resolveRef = async (spec: ResolvedAccountSpec): Promise<string | undefined> => {
    // 防御性校验：即使外部构造了 isLiteral=true，也不得让 ref 原文进入请求。
    if (spec.isLiteral || !isCredentialRefName(spec.ref)) return undefined;
    const ref = credentialRef(spec.ref);
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(ref);
      if (resolved !== undefined && resolved.value !== undefined && resolved.value !== '') return resolved.value;
    }
    const ambient = launchEnvironmentOf(ctx).get(spec.ref);
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value;
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
    rejection: 'invalid-credential',
  ): Promise<string | undefined> => {
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
        ...(resolved.modelSelection !== undefined ? { modelSelection: resolved.modelSelection } : {}),
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

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source;
      },
      onChange: () => {
        lastRaw = undefined;
        lastGood = undefined;
      },
    });
  });
}
