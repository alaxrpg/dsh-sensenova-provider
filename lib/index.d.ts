import z from "@deepseek-ai/schemastery";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";

//#region ../src/adapter.d.ts
/** 手动模型可选覆盖（用户设置持久化）。 */
interface ModelSelection {
  include: readonly string[];
  exclude: readonly string[];
}
//#endregion
//#region ../src/index.d.ts
declare const name = "llm-sensenova";
declare const inject: string[];
declare const DEFAULT_API_KEY_ENV = "SENSENOVA_API_KEY";
declare const DEFAULT_API_BASE = "https://token.sensenova.cn/v1";
/** 一个额外账户（settings 数组元素）。apiKeyEnv 为 credential-ref。 */
interface SensenovaAccountConfig {
  id?: string;
  label?: string;
  apiKeyEnv?: string;
}
/** 插件配置（schemastery schema 的输出形状，所有字段均可选）。 */
interface SensenovaConfig {
  apiKeyEnv?: string;
  apiBase?: string;
  accounts?: SensenovaAccountConfig[];
  activeAccount?: string;
  modelSelection?: {
    include?: string[];
    exclude?: string[];
  };
  /** 每 key 并发生成请求上限（正整数，默认 1）。 */
  concurrency?: number;
}
declare const Config: z<SensenovaConfig>;
/** 一个解析后的账户槽位：id/label + 合法 credential-ref 名。 */
interface ResolvedAccountSpec {
  id: string;
  label: string;
  /** 合法 credential-ref 名；非法输入不会保留原文。 */
  ref: string;
  /** 为兼容公开类型保留；当前解析路径始终为 false，不承载字面密钥。 */
  isLiteral: boolean;
}
/** resolveAdapterOptions 的输出：连接事实 + 账户槽位。 */
interface ResolvedSensenovaOptions {
  apiBase: string;
  activeAccount: string;
  accounts: ResolvedAccountSpec[];
  concurrency: number;
  modelSelection?: ModelSelection;
}
/** 把配置的并发上限归一化为正整数（非正整数/无法解析回退 1）。 */
declare function normalizeConcurrency(value: unknown): number;
/** 规范化用户模型选择配置；未配置时保持 undefined，便于 settings unset。 */
declare function normalizeModelSelection(selection: SensenovaConfig['modelSelection']): ModelSelection | undefined;
/**
 * 从原始 config 到解析后连接事实的唯一显式步骤。程序化构造可能绕过
 * Schemastery 归一化，因此每个默认值在此重新判定——既用于加载时的组合配置，
 * 也用于 settings 快照首次使用。
 */
declare function resolveAdapterOptions(config: SensenovaConfig): ResolvedSensenovaOptions;
declare function apply(ctx: Context, config: SensenovaConfig): void;
//#endregion
export { Config, DEFAULT_API_BASE, DEFAULT_API_KEY_ENV, ResolvedAccountSpec, ResolvedSensenovaOptions, SensenovaAccountConfig, SensenovaConfig, apply, inject, name, normalizeConcurrency, normalizeModelSelection, resolveAdapterOptions };
//# sourceMappingURL=index.d.ts.map