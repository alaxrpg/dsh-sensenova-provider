import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
export declare const name = "llm-sensenova";
export declare const inject: string[];
export declare const DEFAULT_API_KEY_ENV = "SENSENOVA_API_KEY";
export declare const DEFAULT_API_BASE = "https://token.sensenova.cn/v1";
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
  /** 每 key 并发生成请求上限（正整数，默认 1）。 */
  concurrency?: number;
  /** 配额类 429 粘性换 key（design D5，默认关；401 行为不变，任何 429 不冷却账号）。 */
  quotaRotation?: boolean;
}
export declare const Config: z<SensenovaConfig>;
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
}
/** 把配置的并发上限归一化为正整数（非正整数/无法解析回退 1）。 */
export declare function normalizeConcurrency(value: unknown): number;
/**
 * 从原始 config 到解析后连接事实的唯一显式步骤。程序化构造可能绕过
 * Schemastery 归一化，因此每个默认值在此重新判定——既用于加载时的组合配置，
 * 也用于 settings 快照首次使用。
 */
export declare function resolveAdapterOptions(config: SensenovaConfig): ResolvedSensenovaOptions;
export declare function apply(ctx: Context, config: SensenovaConfig): void;
//#endregion
//# sourceMappingURL=index.d.ts.map