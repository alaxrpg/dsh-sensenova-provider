/**
 * SenseNova 设置页的领域层（无 JSX）：把 `llm-sensenova` 设置命名空间与
 * credentials 域桥接到页面状态。宿主是唯一事实来源，保存即热生效。
 *
 * 与 @mars-sea/dsh-commandcode-provider 的 SettingsController 同构，但只保留
 * 多账户配置所需的最小面：apiBase、默认凭据引用 apiKeyEnv、accounts 增删与
 * activeAccount 单选；API key 一律经 credentials 域写入（credential-ref），
 * 页面不回显明文。
 */

/** 设置命名空间与 provider 路由（与冻结契约一致）。 */
export const SENSENOVA_NS = 'llm-sensenova';
export const SENSENOVA_ROUTE = 'sensenova';
export const SENSENOVA_DISPLAY_NAME = 'SenseNova';

/** 默认 apiBase 与默认凭据环境变量。 */
export const DEFAULT_API_BASE = 'https://token.sensenova.cn/v1';
export const DEFAULT_API_KEY_ENV = 'SENSENOVA_API_KEY';
/** 默认每 key 并发生成请求上限（并发闸缺省值）。 */
export const DEFAULT_CONCURRENCY = 1;

/** 把并发上限输入归一化为正整数（非法/无法解析回退默认 1）。 */
export function normalizeConcurrency(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  return DEFAULT_CONCURRENCY;
}

/** 可编辑的设置字段。 */
export type FieldName = 'apiBase' | 'apiKeyEnv' | 'activeAccount' | 'concurrency' | 'modelSelectionInclude' | 'modelSelectionExclude';

/** accounts 数组元素（与冻结契约一致）。 */
export interface AccountConfig {
  id: string;
  label: string;
  apiKeyEnv: string;
}

/** 设置命名空间中的用户配置形状。 */
export interface SenseNovaConfig {
  apiBase?: string;
  apiKeyEnv?: string;
  accounts?: AccountConfig[];
  activeAccount?: string;
  modelSelection?: { include?: string[]; exclude?: string[] };
  /** 每 key 并发生成请求上限（正整数，默认 1）。 */
  concurrency?: number;
}

/** credentials 域提供的面（对齐参考实现的 remote.credentials）。 */
export interface CredentialView {
  configured: boolean;
  writable: boolean;
}

export interface CredentialsDescribeResult {
  ok: boolean;
  value?: Record<string, CredentialView>;
}

export interface CredentialsFace {
  describe(refs: string[]): Promise<CredentialsDescribeResult>;
  set(ref: string, value: string): Promise<{ ok: boolean }>;
  unset(ref: string): Promise<{ ok: boolean }>;
}

/** 设置 scope 的最小面（对齐 SettingsScope<T>）。 */
export interface ScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable';
  value: T | undefined;
  base: unknown;
  user: unknown;
  writable: boolean;
  mode: 'host' | 'memory';
}

export interface SettingsScope<T> {
  getSnapshot(): ScopeSnapshot<T>;
  subscribe(fn: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
}

/** 页面渲染用的账户行。 */
export interface AccountView {
  id: string;
  ref: string;
  label: string;
  labelDraft: string;
  keyDraft: string;
  configured: boolean;
  writable: boolean;
  added: boolean;
  clearStaged: boolean;
}

/** 页面渲染用的设置快照（稳定引用，变更时整体替换）。 */
export interface SettingsState {
  available: boolean;
  writable: boolean;
  route: string;
  displayName: string;
  apiBase: string;
  apiBaseDraft: string;
  apiKeyEnv: string;
  apiKeyEnvDraft: string;
  defaultConfigured: boolean;
  defaultWritable: boolean;
  defaultKeyDraft: string;
  defaultClearStaged: boolean;
  accounts: AccountView[];
  activeAccount: string;
  activeAccountDraft: string;
  /** 当前实际生效账户 id（'default' 指默认账户卡，'' 表示无已配置账户）。 */
  effectiveActiveAccountId: string;
  /** 当前实际生效账户的可读标签（用于自动模式下展示「当前: xxx」）。 */
  effectiveActiveAccountLabel: string;
  /** 已配置（有可用密钥）的账户总数（含默认）。 */
  configuredCount: number;
  /** 账户总数（含默认账户，不含未保存新增行）。 */
  totalCount: number;
  concurrency: number;
  concurrencyDraft: string;
  modelSelectionInclude: string[];
  modelSelectionExclude: string[];
  modelSelectionIncludeDraft: string;
  modelSelectionExcludeDraft: string;
  dirty: boolean;
  saving: boolean;
  failed: boolean;
  savedCount: number;
}

/** 稳定的外部状态订阅源（uSES 兼容，供 slots 的 hooks 注入）。 */
export interface SnapshotStore<T> {
  getSnapshot(): T;
  subscribe(fn: () => void): () => void;
  set(value: T): void;
}

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** 创建一个小型可观察快照 store（参考实现的 createSnapshotStore 精简版）。 */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(value) {
      if (Object.is(value, snapshot)) return;
      snapshot = value;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.error('[dsh-sensenova-provider] snapshot subscriber failed:', error);
        }
      }
    },
  };
}

/** 与宿主 credentials 的 canonical credential-ref 规则一致（POSIX shell 标识符）。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function canonicalCredentialRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed !== '' && CREDENTIAL_REF_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** 从 section 值中读取凭据引用；未配置时回退默认，非法值则视为无凭据。 */
function credentialRefOf(apiKeyEnv: unknown): string | undefined {
  if (apiKeyEnv === undefined) return DEFAULT_API_KEY_ENV;
  return canonicalCredentialRef(apiKeyEnv);
}

/** 从 section 值中读取 apiBase（空则回退默认）。 */
function apiBaseOf(apiBase: unknown): string {
  return typeof apiBase === 'string' && apiBase.length > 0 ? apiBase : DEFAULT_API_BASE;
}

/** 从 section 值中解析 stored accounts（过滤非法条目）。 */
function modelIdsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id !== '' && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** textarea 领域解析：换行或逗号分隔，规范化并稳定去重。 */
export function parseModelIds(text: string): string[] {
  return modelIdsOf(text.split(/[\n,]+/));
}

function modelSelectionOf(raw: unknown): { include: string[]; exclude: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { include: [], exclude: [] };
  const selection = raw as Record<string, unknown>;
  return { include: modelIdsOf(selection.include), exclude: modelIdsOf(selection.exclude) };
}

function storedAccountsOf(raw: unknown): AccountConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: AccountConfig[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const label = record.label;
    const apiKeyEnv = canonicalCredentialRef(record.apiKeyEnv);
    if (apiKeyEnv === undefined) continue;
    out.push({
      id: typeof id === 'string' && id.trim() !== '' ? id.trim() : apiKeyEnv,
      label: typeof label === 'string' && label.trim() !== '' ? label.trim() : apiKeyEnv,
      apiKeyEnv,
    });
  }
  return out;
}

export class SenseNovaSettingsController {
  private readonly scope: SettingsScope<SenseNovaConfig>;
  private readonly credentials: CredentialsFace;

  private stagedApiBase: string | undefined;
  private stagedApiKeyEnv: string | undefined;
  private stagedActiveAccount: string | undefined;
  private stagedConcurrency: string | undefined;
  private stagedModelSelectionInclude: string | undefined;
  private stagedModelSelectionExclude: string | undefined;

  private defaultKeyDraft = '';
  private defaultClearStaged = false;

  private addedAccounts: AccountConfig[] = [];
  private removedIds = new Set<string>();
  private labelDrafts = new Map<string, string>();
  private keyDrafts = new Map<string, string>();
  private keyClears = new Set<string>();

  private credentialStates = new Map<string, CredentialView>();

  /** 上一次成功 describeAll 查询过的 refs 集合键（去重排序拼接）；用于检测快照替换引入的新 ref。 */
  private describedRefsKey = '';

  private saving = false;
  private failed = false;
  private savedCount = 0;

  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(scope: SettingsScope<SenseNovaConfig>, credentials: CredentialsFace) {
    this.scope = scope;
    this.credentials = credentials;
    this.disposers.push(
      scope.subscribe(() => {
        this.publish();
        // 快照替换可能引入新 credential-ref（典型：构造时快照 loading、就绪后 accounts
        // 才可见），集合变化时重查凭据配置状态，避免额外账户残留「未配置」误报。
        this.describeIfRefsChanged();
      }),
    );
    void this.describeAll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 默认账户的凭据引用：优先 staged 草稿，其次 section 值，最后回退默认。 */
  credentialRef(): string | undefined {
    return credentialRefOf(this.stagedApiKeyEnv ?? this.sectionValue('apiKeyEnv'));
  }

  storedAccounts(): AccountConfig[] {
    return storedAccountsOf(this.sectionValue('accounts'));
  }

  /** 当前 section 值（快照未就绪时 undefined）。 */
  private sectionValue(field: keyof SenseNovaConfig): unknown {
    return this.scope.getSnapshot().value?.[field];
  }

  /** 页面状态面。 */
  state(): SettingsState {
    const snapshot = this.scope.getSnapshot();
    const ref = this.credentialRef();
    const defaultView = ref === undefined ? undefined : this.credentialStates.get(ref);
    const accounts = this.effectiveAccounts();
    const apiBase = apiBaseOf(this.sectionValue('apiBase'));
    const apiKeyEnv = credentialRefOf(this.sectionValue('apiKeyEnv')) ?? '';
    const activeAccount = typeof this.sectionValue('activeAccount') === 'string' ? (this.sectionValue('activeAccount') as string) : '';
    const modelSelection = modelSelectionOf(this.sectionValue('modelSelection'));
    const concurrency = normalizeConcurrency(this.sectionValue('concurrency'));
    const effectiveActiveAccountId = this.effectiveActiveAccountId(activeAccount, defaultView?.configured ?? false);
    const effectiveActiveAccountLabel = this.effectiveActiveAccountLabel(effectiveActiveAccountId, accounts);
    const configuredCount = (defaultView?.configured ? 1 : 0) + accounts.filter((a) => a.configured).length;
    const totalCount = 1 + accounts.filter((a) => !a.added).length;

    const dirty =
      this.stagedApiBase !== undefined ||
      this.stagedApiKeyEnv !== undefined ||
      this.stagedActiveAccount !== undefined ||
      this.stagedConcurrency !== undefined ||
      this.stagedModelSelectionInclude !== undefined ||
      this.stagedModelSelectionExclude !== undefined ||
      this.defaultKeyDraft !== '' ||
      this.defaultClearStaged ||
      this.addedAccounts.length > 0 ||
      this.removedIds.size > 0 ||
      this.labelDrafts.size > 0 ||
      this.keyDrafts.size > 0 ||
      this.keyClears.size > 0;

    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      route: SENSENOVA_ROUTE,
      displayName: SENSENOVA_DISPLAY_NAME,
      apiBase,
      apiBaseDraft: this.stagedApiBase ?? apiBase,
      apiKeyEnv,
      apiKeyEnvDraft: this.stagedApiKeyEnv ?? apiKeyEnv,
      defaultConfigured: defaultView?.configured ?? false,
      defaultWritable: defaultView?.writable ?? true,
      defaultKeyDraft: this.defaultKeyDraft,
      defaultClearStaged: this.defaultClearStaged,
      accounts,
      activeAccount,
      activeAccountDraft: this.stagedActiveAccount ?? activeAccount,
      effectiveActiveAccountId,
      effectiveActiveAccountLabel,
      configuredCount,
      totalCount,
      concurrency,
      concurrencyDraft: this.stagedConcurrency ?? String(concurrency),
      modelSelectionInclude: modelSelection.include,
      modelSelectionExclude: modelSelection.exclude,
      modelSelectionIncludeDraft: this.stagedModelSelectionInclude ?? modelSelection.include.join('\n'),
      modelSelectionExcludeDraft: this.stagedModelSelectionExclude ?? modelSelection.exclude.join('\n'),
      dirty,
      saving: this.saving,
      failed: this.failed,
      savedCount: this.savedCount,
    };
  }

  /**
   * 计算当前实际生效账户 id：
   * - 显式钉选（activeAccount 非空且指向已保存账户）→ 该 id；
   * - 自动模式 → 默认账户已配置取 'default'，否则第一个已配置账户行 id，均无则 ''。
   * UI 据此展示「活动/当前」标记（运行时 401 禁用后的顺延以实际可用账号为准）。
   */
  private effectiveActiveAccountId(activeAccount: string, defaultConfigured: boolean): string {
    if (activeAccount !== '') {
      const pinned = this.effectiveAccounts().find((a) => a.id === activeAccount);
      if (pinned !== undefined && pinned.configured) return pinned.id;
      // 钉选账户未配置时视为自动。
    }
    if (defaultConfigured) return 'default';
    const firstConfigured = this.effectiveAccounts().find((a) => a.configured);
    return firstConfigured !== undefined ? firstConfigured.id : '';
  }

  /**
   * 当前实际生效账户的可读标签：'default' → 「默认账户」，
   * 其余取账户行 labelDraft（空则回退「账户 N」），无生效则 ''。
   * 用于自动模式下下拉选项与总览条展示「当前: xxx」。
   */
  private effectiveActiveAccountLabel(id: string, accounts: AccountView[]): string {
    if (id === '') return '';
    if (id === 'default') return '默认账户';
    const account = accounts.find((a) => a.id === id);
    if (account === undefined) return id;
    const label = account.labelDraft.trim();
    return label !== '' ? label : `账户 ${accounts.indexOf(account) + 1}`;
  }

  /** 合并 stored（减 staged 删除）与 staged 新增，得到展示用账户行。 */
  private effectiveAccounts(): AccountView[] {
    const stored = this.storedAccounts()
      .filter((a) => !this.removedIds.has(a.id))
      .map((a) => ({ ...a, added: false }));
    const added = this.addedAccounts.map((a) => ({ ...a, added: true }));
    return [...stored, ...added].map((a) => {
      const view = this.credentialStates.get(a.apiKeyEnv);
      return {
        id: a.id,
        ref: a.apiKeyEnv,
        label: a.label,
        labelDraft: this.labelDrafts.get(a.id) ?? a.label,
        keyDraft: this.keyDrafts.get(a.id) ?? '',
        configured: view?.configured ?? false,
        writable: view?.writable ?? true,
        added: a.added,
        clearStaged: this.keyClears.has(a.id),
      };
    });
  }

  // ---- 编辑动作 ----

  edit(field: FieldName, text: string): void {
    if (field === 'apiBase') this.stagedApiBase = text;
    else if (field === 'apiKeyEnv') this.stagedApiKeyEnv = text;
    else if (field === 'activeAccount') this.stagedActiveAccount = text;
    else if (field === 'concurrency') this.stagedConcurrency = text;
    else if (field === 'modelSelectionInclude') this.stagedModelSelectionInclude = text;
    else this.stagedModelSelectionExclude = text;
    this.failed = false;
    this.publish();
  }

  editDefaultKey(text: string): void {
    this.defaultKeyDraft = text;
    this.defaultClearStaged = false;
    this.failed = false;
    this.publish();
  }

  toggleDefaultKeyClear(): void {
    this.defaultClearStaged = !this.defaultClearStaged;
    if (this.defaultClearStaged) this.defaultKeyDraft = '';
    this.failed = false;
    this.publish();
  }

  addAccount(): void {
    const usedRefs = new Set<string>([
      ...(this.credentialRef() !== undefined ? [this.credentialRef() as string] : []),
      ...this.storedAccounts().map((a) => a.apiKeyEnv),
      ...this.addedAccounts.map((a) => a.apiKeyEnv),
    ]);
    let n = 2;
    while (usedRefs.has(`${DEFAULT_API_KEY_ENV}_${n}`)) n += 1;
    const apiKeyEnv = `${DEFAULT_API_KEY_ENV}_${n}`;

    const usedIds = new Set<string>([...this.storedAccounts().map((a) => a.id), ...this.addedAccounts.map((a) => a.id)]);
    let k = this.storedAccounts().length + this.addedAccounts.length + 2;
    let id = `account-${k}`;
    while (usedIds.has(id)) {
      k += 1;
      id = `account-${k}`;
    }

    this.addedAccounts.push({ id, label: `账户 ${k}`, apiKeyEnv });
    this.failed = false;
    void this.describeAll();
    this.publish();
  }

  removeAccount(id: string): void {
    const addedIndex = this.addedAccounts.findIndex((a) => a.id === id);
    if (addedIndex >= 0) this.addedAccounts.splice(addedIndex, 1);
    else this.removedIds.add(id);
    this.labelDrafts.delete(id);
    this.keyDrafts.delete(id);
    this.keyClears.delete(id);
    const currentActive = this.sectionValue('activeAccount');
    if (this.stagedActiveAccount === id || (this.stagedActiveAccount === undefined && currentActive === id)) {
      this.stagedActiveAccount = '';
    }
    this.failed = false;
    this.publish();
  }

  editAccountLabel(id: string, text: string): void {
    this.labelDrafts.set(id, text);
    this.failed = false;
    this.publish();
  }

  editAccountKey(id: string, text: string): void {
    this.keyDrafts.set(id, text);
    this.keyClears.delete(id);
    this.failed = false;
    this.publish();
  }

  toggleAccountKeyClear(id: string): void {
    if (this.keyClears.has(id)) this.keyClears.delete(id);
    else {
      this.keyDrafts.delete(id);
      this.keyClears.add(id);
    }
    this.failed = false;
    this.publish();
  }

  /** activeAccount 单选：'' 表示自动（默认账户优先）。 */
  setActiveAccount(id: string): void {
    this.stagedActiveAccount = id;
    this.failed = false;
    this.publish();
  }

  /** 丢弃所有 staged 编辑。 */
  discard(): void {
    this.stagedApiBase = undefined;
    this.stagedApiKeyEnv = undefined;
    this.stagedActiveAccount = undefined;
    this.stagedConcurrency = undefined;
    this.stagedModelSelectionInclude = undefined;
    this.stagedModelSelectionExclude = undefined;
    this.defaultKeyDraft = '';
    this.defaultClearStaged = false;
    this.addedAccounts = [];
    this.removedIds.clear();
    this.labelDrafts.clear();
    this.keyDrafts.clear();
    this.keyClears.clear();
    this.failed = false;
    this.publish();
  }

  /** 凭据域状态重读（外部写入 key 后刷新已配置/可写徽标）。 */
  async refreshCredentials(): Promise<void> {
    await this.describeAll();
  }

  /** 当前页面涉及的 credential-ref 集合键（默认 ref + stored/added 账户 ref）。 */
  private currentRefsKey(): string {
    const ref = this.credentialRef();
    const refs = new Set<string>([
      ...(ref !== undefined ? [ref] : []),
      ...this.storedAccounts().map((a) => a.apiKeyEnv),
      ...this.addedAccounts.map((a) => a.apiKeyEnv),
    ]);
    return [...refs].sort().join(',');
  }

  /** refs 集合与上次成功查询不同则重查；查询失败保留旧键，下次快照变更自然重试。 */
  private describeIfRefsChanged(): void {
    if (this.currentRefsKey() === this.describedRefsKey) return;
    void this.describeAll();
  }

  /** 查询所有本页涉及的凭据引用的配置状态。 */
  private async describeAll(): Promise<void> {
    const refs = [
      ...(this.credentialRef() !== undefined ? [this.credentialRef() as string] : []),
      ...this.storedAccounts().map((a) => a.apiKeyEnv),
      ...this.addedAccounts.map((a) => a.apiKeyEnv),
    ];
    if (refs.length === 0) {
      this.describedRefsKey = '';
      return;
    }
    let response: CredentialsDescribeResult;
    try {
      response = await this.credentials.describe(refs);
    } catch {
      return;
    }
    if (!response.ok) return;
    this.describedRefsKey = this.currentRefsKey();
    let changed = false;
    for (const ref of refs) {
      const view = response.value?.[ref];
      const next: CredentialView = {
        configured: view?.configured ?? false,
        writable: view?.writable ?? true,
      };
      const prev = this.credentialStates.get(ref);
      if (prev === undefined || prev.configured !== next.configured || prev.writable !== next.writable) {
        this.credentialStates.set(ref, next);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  /** 写入某个凭据引用，然后重读配置状态。 */
  private async writeKeyTo(ref: string, value: string): Promise<boolean> {
    const canonicalRef = canonicalCredentialRef(ref);
    if (canonicalRef === undefined) return false;
    try {
      const result = await this.credentials.set(canonicalRef, value);
      if (!result.ok) return false;
    } catch {
      return false;
    }
    await this.describeAll();
    return this.credentialStates.get(canonicalRef)?.configured ?? false;
  }

  private async unsetKey(ref: string): Promise<boolean> {
    const canonicalRef = canonicalCredentialRef(ref);
    if (canonicalRef === undefined) return false;
    try {
      const result = await this.credentials.unset(canonicalRef);
      if (!result.ok) return false;
    } catch {
      return false;
    }
    await this.describeAll();
    return this.credentialStates.get(canonicalRef)?.configured !== true;
  }

  /** 持久化 accounts 列表。 */
  private async writeAccounts(): Promise<boolean> {
    const base = [
      ...this.storedAccounts().filter((a) => !this.removedIds.has(a.id)),
      ...this.addedAccounts,
    ];
    const seen = new Set<string>();
    const list: AccountConfig[] = [];
    for (const a of base) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const label = this.labelDrafts.get(a.id)?.trim();
      list.push({
        id: a.id,
        label: label !== undefined && label !== '' ? label : a.label,
        apiKeyEnv: a.apiKeyEnv,
      });
    }
    await this.scope.set('accounts', list);
    return true;
  }

  /** 保存所有 staged 编辑。 */
  async save(): Promise<void> {
    if (this.saving) return;
    const state = this.state();
    if (!state.dirty) return;
    this.saving = true;
    this.failed = false;
    this.publish();

    let landed = true;
    try {
      // 1. 凭据域写入：默认 key、清 key、额外账户 key。
      const defaultRef = this.credentialRef();
      if (this.defaultClearStaged) {
        if (defaultRef === undefined || !(await this.unsetKey(defaultRef))) landed = false;
      } else if (this.defaultKeyDraft.trim() !== '') {
        if (defaultRef === undefined || !(await this.writeKeyTo(defaultRef, this.defaultKeyDraft.trim()))) landed = false;
      }
      for (const id of this.keyClears) {
        const account = this.effectiveAccounts().find((a) => a.id === id);
        if (account !== undefined && !(await this.unsetKey(account.ref))) landed = false;
      }
      for (const [id, text] of this.keyDrafts) {
        const value = text.trim();
        if (value === '' || this.keyClears.has(id)) continue;
        const account = this.effectiveAccounts().find((a) => a.id === id);
        if (account !== undefined && !(await this.writeKeyTo(account.ref, value))) landed = false;
      }

      // 2. 设置字段写入（apiBase / apiKeyEnv / activeAccount / accounts）。
      if (this.stagedApiBase !== undefined) {
        const value = this.stagedApiBase.trim();
        if (value === '') await this.scope.unset('apiBase');
        else await this.scope.set('apiBase', value);
      }
      if (this.stagedApiKeyEnv !== undefined) {
        const canonicalRef = canonicalCredentialRef(this.stagedApiKeyEnv);
        if (this.stagedApiKeyEnv.trim() === '') await this.scope.unset('apiKeyEnv');
        else if (canonicalRef === undefined) landed = false;
        else await this.scope.set('apiKeyEnv', canonicalRef);
      }
      if (this.stagedActiveAccount !== undefined) {
        if (this.stagedActiveAccount === '') await this.scope.unset('activeAccount');
        else await this.scope.set('activeAccount', this.stagedActiveAccount);
      }
      if (this.stagedConcurrency !== undefined) {
        const value = normalizeConcurrency(this.stagedConcurrency);
        await this.scope.set('concurrency', value);
      }
      if (this.stagedModelSelectionInclude !== undefined || this.stagedModelSelectionExclude !== undefined) {
        const current = modelSelectionOf(this.sectionValue('modelSelection'));
        const selection = {
          include: this.stagedModelSelectionInclude !== undefined
            ? parseModelIds(this.stagedModelSelectionInclude)
            : current.include,
          exclude: this.stagedModelSelectionExclude !== undefined
            ? parseModelIds(this.stagedModelSelectionExclude)
            : current.exclude,
        };
        if (selection.include.length === 0 && selection.exclude.length === 0) await this.scope.unset('modelSelection');
        else await this.scope.set('modelSelection', selection);
      }
      if (this.addedAccounts.length > 0 || this.removedIds.size > 0 || this.labelDrafts.size > 0) {
        await this.writeAccounts();
      }
    } catch {
      landed = false;
    }

    this.saving = false;
    this.failed = !landed;
    if (landed) {
      this.savedCount += 1;
      this.discard();
    }
    this.publish();
  }

  private publish(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[dsh-sensenova-provider] state subscriber failed:', error);
      }
    }
  }
}
