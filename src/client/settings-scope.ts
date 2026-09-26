/**
 * 直接构建在 `remote.settings` wire 上的客户端设置 scope。
 *
 * 背景：0.1.7 的 settings 重写移除了宿主的 `settingsScope` 包装服务（该服务只存在于
 * 0.1.6 及更早），但底层 `settings.describe` / `settings.mutate` RPC 在所有受支持
 * 版本上都存在。这里把旧 `SettingsScope<T>` 的面（getSnapshot / subscribe / set /
 * unset）重新实现在 wire 上，因此 SenseNovaSettingsController 与既有测试无需改动。
 *
 * 与 @mars-sea/dsh-commandcode-provider 0.11.16 的 `src/client/settings-scope.ts`
 * 同构：一次 describe 共享镜像 + 每命名空间一个 scope；写入经单飞队列串行化，
 * 并用 describe 返回的 revision 做并发栅栏（冲突时重读宿主，绝不静默覆盖）。
 */

import {
  createSnapshotStore,
  type ScopeSnapshot,
  type SettingsScope,
  type SnapshotStore,
} from './settings.ts';

/** 一次命名空间写入操作（与宿主 `settings.mutate` 的 ops 元素同构）。 */
export type SettingsOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] };

/** describe/mutate 返回的单个命名空间视图（字段含义由宿主 settings 域定义）。 */
export interface SettingsNamespaceView {
  ns: string;
  value?: unknown;
  base?: unknown;
  user?: unknown;
  revision?: number;
}

/** `settings.describe` 返回的整份文档视图。 */
export interface SettingsDocumentView {
  writable?: boolean;
  namespaces?: SettingsNamespaceView[];
}

/** Remote 调用的统一信封。 */
export interface SettingsRemoteResponse<T> {
  ok: boolean;
  value?: T;
  error?: { code?: string; message?: string };
}

/**
 * `remote.settings` 命名空间的最小面。
 *
 * 注意：`remote.settings` 是 `remote` 下的嵌套服务，直接用自己的 ctx 读会抛错，
 * 必须在 `ctx.inject(['remote.settings'], …)` 内捕获后通过 {@link SettingsRemoteResolver}
 * 延迟读取。
 */
export interface SettingsRemoteNamespace {
  describe(): Promise<SettingsRemoteResponse<SettingsDocumentView>>;
  mutate(
    ns: string,
    ops: SettingsOp[],
    expectedRevision?: number,
  ): Promise<SettingsRemoteResponse<SettingsNamespaceView>>;
}

/** 读取注入捕获的 `remote.settings`；命名空间未挂载时返回 undefined。 */
export type SettingsRemoteResolver = () => SettingsRemoteNamespace | undefined;

/** 重试定时器接缝（测试可注入假定时器）。 */
export interface SettingsTimer {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** scope 需要的上下文面：只用到 `remote.$on` 与本地 cordis `on`。 */
export interface SettingsScopeContextLike {
  remote?: { $on?: (event: string, listener: () => void) => (() => void) | void };
  on?: (event: string, listener: () => void) => (() => void) | void;
}

/** `createSettingsScope` 返回的面：旧 SettingsScope + refresh/dispose。 */
export interface ManagedSettingsScope<T> extends SettingsScope<T> {
  /** 命名空间挂载后重读宿主（首次 describe 早于注入落地时使用）。 */
  refresh(): void;
  /** 注销事件订阅、停掉镜像并等待在途 wire 调用结束。 */
  dispose(): Promise<void>;
}

/**
 * 首次 describe 失败时的退避阶梯（毫秒）。
 *
 * 首次读可能输给尚未就绪的宿主（网关 WS 握手、settings 服务启动中）：失败是瞬时的，
 * 但此时镜像什么都没持有，scope 会停在初始 `loading` / 只读状态，页面所有控件都会
 * 显示为禁用；而转发事件 `settings/document-updated` 与 `connection/reset` 都需要
 * 活着的宿主才会触发，命名空间也只在刷新页面时重新挂载 —— 所以「一无所获的失败」
 * 按此有界阶梯重试；「已持有视图的失败」保留旧视图、不重试（页面已显示最后一份好文档）。
 */
const SETTINGS_DESCRIBE_RETRY_MS = [1000, 2000, 4000];

/** 生产定时器：普通 timeout，不轮询。 */
const REAL_SETTINGS_TIMER: SettingsTimer = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms) as ReturnType<typeof setTimeout> & { unref?: () => void };
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** 逐字段比较快照，未变化的推导不惊动订阅者。 */
function sameSnapshot(a: ScopeSnapshot<unknown>, b: ScopeSnapshot<unknown>): boolean {
  return (
    a.status === b.status &&
    Object.is(a.value, b.value) &&
    Object.is(a.base, b.base) &&
    Object.is(a.user, b.user) &&
    a.revision === b.revision &&
    a.writable === b.writable &&
    a.mode === b.mode
  );
}

/** 仅接受「设置段就是对象」的行值。 */
function decodeRow(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 镜像的内部快照。 */
interface MirrorSnapshot {
  status: 'idle' | 'loading' | 'ready';
  view: SettingsDocumentView | null;
  error: string | null;
}

/**
 * 宿主 `settings.describe()` 视图的共享镜像。
 *
 * 运行循环沿用宿主自身的做法：在 `inFlight` 后面串行化，把并发失效折叠成恰好一次重跑，
 * 读失败时保留上一份视图（`status` 停在 `ready` 并携带 `error`；从未持有过则回到 `idle`）。
 */
export class SettingsDescribeMirror {
  private readonly store: SnapshotStore<MirrorSnapshot>;
  private readonly timer: SettingsTimer;
  private inFlight: Promise<void> | undefined;
  private rerun = false;
  private generation = 0;
  private retryHandle: unknown;
  private retries = 0;
  private disposed = false;

  constructor(
    private readonly resolveRemote: SettingsRemoteResolver,
    timer: SettingsTimer = REAL_SETTINGS_TIMER,
  ) {
    this.timer = timer;
    this.store = createSnapshotStore<MirrorSnapshot>({ status: 'idle', view: null, error: null });
  }

  getSnapshot(): MirrorSnapshot {
    return this.store.getSnapshot();
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  /** 幂等的入口：踢一次首读。 */
  ensure(): void {
    void this.load();
  }

  /**
   * 从宿主刷新。若已有在途读取，则标记一次重跑，而不是并发第二次 wire 调用。
   * @returns 本次调用之后的读取已落定。
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.clearRetry();
    if (this.inFlight !== undefined) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = Promise.resolve().then(() => this.run());
    this.inFlight = run;
    return run;
  }

  /**
   * 把一次写入应答里的命名空间行折进已持有的视图（不再走一次 wire 读），
   * 并作废仍在途的读取：写入提交前开始的读取不得把写入前的文档盖回来。
   * 未持有文档时，应答不作为「部分文档」发布 —— 交给下一次读取或失败恢复。
   */
  acceptView(row: SettingsNamespaceView): void {
    const before = this.store.getSnapshot();
    this.generation += 1;
    if (this.inFlight !== undefined) this.rerun = true;
    if (before.view === null) return;
    const held = before.view;
    const namespaces = held.namespaces?.some((candidate) => candidate.ns === row.ns)
      ? held.namespaces.map((candidate) => (candidate.ns === row.ns ? row : candidate))
      : [...(held.namespaces ?? []), row];
    this.store.set({ ...before, view: { ...held, namespaces } });
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        const before = this.store.getSnapshot();
        if (before.status === 'idle') this.store.set({ ...before, status: 'loading' });
        this.rerun = false;
        const generation = ++this.generation;
        let outcome: { view: SettingsDocumentView } | { failure: string };
        try {
          const namespace = this.resolveRemote();
          if (namespace === undefined) throw new Error('the settings remote namespace is not mounted');
          const response = await namespace.describe();
          if (response.ok) {
            const value = response.value;
            outcome =
              typeof value === 'object' && value !== null
                ? { view: value }
                : { failure: 'settings describe answered no view' };
          } else {
            outcome = { failure: response.error?.message ?? 'settings describe failed' };
          }
        } catch (error) {
          outcome = { failure: error instanceof Error ? error.message : String(error) };
        }
        if (generation !== this.generation) continue;
        if ('view' in outcome) {
          this.retries = 0;
          this.store.set({ status: 'ready', view: outcome.view, error: null });
        } else {
          const held = this.store.getSnapshot();
          this.store.set({
            status: held.view === null ? 'idle' : 'ready',
            view: held.view,
            error: outcome.failure,
          });
          if (held.view === null) this.scheduleRetry();
        }
        if (!this.rerun) break;
      }
    } finally {
      this.inFlight = undefined;
    }
  }

  /** 为「首读失败」安排下一次重试；阶梯用尽后停在降级快照，直到失效事件或重新挂载。 */
  private scheduleRetry(): void {
    if (this.disposed || this.retries >= SETTINGS_DESCRIBE_RETRY_MS.length) return;
    const delay = SETTINGS_DESCRIBE_RETRY_MS[this.retries];
    if (delay === undefined) return;
    this.retries += 1;
    this.retryHandle = this.timer.set(() => {
      this.retryHandle = undefined;
      void this.load();
    }, delay);
  }

  /** 取消待执行的重试（开始一次实时读取，或 scope 即将销毁）。 */
  private clearRetry(): void {
    if (this.retryHandle !== undefined) this.timer.clear(this.retryHandle);
    this.retryHandle = undefined;
  }

  /** 停止镜像：不再读取，销毁后重试也不得触发。 */
  dispose(): void {
    this.disposed = true;
    this.clearRetry();
  }
}

/**
 * 单个命名空间的派生 scope + 其串行化的宿主写入。
 *
 * 这是 SenseNovaSettingsController 消费的面（getSnapshot / subscribe / set / unset），
 * 因此控制器本身在新旧两代宿主上都不需要改动。
 */
export class RemoteSettingsScope<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<ScopeSnapshot<T>>;
  private tail: Promise<void> = Promise.resolve();
  private writeGeneration = 0;
  private disposed = false;
  private readonly unsubscribe: () => void;
  /** 已被后续写入取代、但仍领先于镜像的 revision。 */
  private pendingRevision: number | undefined;

  constructor(
    private readonly resolveRemote: SettingsRemoteResolver,
    private readonly mirror: SettingsDescribeMirror,
    private readonly namespace: string,
  ) {
    this.store = createSnapshotStore<ScopeSnapshot<T>>({
      status: 'loading',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'host',
    });
    this.unsubscribe = mirror.subscribe(() => {
      this.derive();
    });
    this.derive();
  }

  getSnapshot(): ScopeSnapshot<T> {
    return this.store.getSnapshot();
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  /** 排队一次字段写入（单路径 `set` 操作形式）。 */
  set(field: string, value: unknown): Promise<boolean> {
    return this.mutate([{ op: 'set', path: [field], value }]);
  }

  /** 排队一次字段清除（单路径 `unset` 操作形式）。 */
  unset(field: string): Promise<boolean> {
    return this.mutate([{ op: 'unset', path: [field] }]);
  }

  /**
   * 在单飞栅栏后排入一次原子命名空间变更。
   *
   * 被拒绝的写入（例如 `SETTINGS_CONFLICT`）会重读宿主，让快照反映真正落地的内容；
   * 被接受的写入直接折进镜像 —— 除非已被更新的写入取代，此时把该次应答的 revision
   * 作为下一次写入的栅栏。
   */
  mutate(ops: SettingsOp[], expectedRevision?: number): Promise<boolean> {
    const ownedOps = structuredClone(ops);
    const generation = ++this.writeGeneration;
    return this.enqueue(async () => {
      const revision = expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision;
      const response = await this.mutateRemote(ownedOps, revision);
      if (!response.ok) {
        await this.recover(generation);
        return false;
      }
      if (this.disposed) return true;
      const row = response.value;
      if (row === undefined) return true;
      if (generation === this.writeGeneration) {
        this.pendingRevision = undefined;
        this.mirror.acceptView(row);
      } else {
        this.pendingRevision = typeof row.revision === 'number' ? row.revision : undefined;
      }
      return true;
    });
  }

  private async mutateRemote(
    ops: SettingsOp[],
    revision: number | undefined,
  ): Promise<SettingsRemoteResponse<SettingsNamespaceView>> {
    try {
      const namespace = this.resolveRemote();
      if (namespace === undefined) {
        return { ok: false, error: { message: 'the settings remote namespace is not mounted' } };
      }
      return await namespace.mutate(this.namespace, ops, revision);
    } catch (error) {
      return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  }

  /** 为最近一次失败的写入重读宿主；已被取代的失败交给更新的写入处理。 */
  private async recover(generation: number): Promise<void> {
    if (this.disposed || generation !== this.writeGeneration) return;
    this.pendingRevision = undefined;
    await this.mirror.load();
  }

  /** 从镜像持有的视图推导本命名空间的快照。 */
  private derive(): void {
    if (this.disposed) return;
    const mirrored = this.mirror.getSnapshot();
    if (mirrored.view === null || mirrored.view === undefined) return;
    const writable = mirrored.view.writable === true;
    const row = mirrored.view.namespaces?.find((candidate) => candidate.ns === this.namespace);
    if (row === undefined) {
      this.publish({ status: 'unavailable', writable });
      return;
    }
    const decoded = decodeRow(row.value);
    if (decoded === undefined) return;
    this.publish({
      status: 'ready',
      writable,
      value: decoded as T,
      base: row.base,
      user: row.user,
      revision: typeof row.revision === 'number' ? row.revision : undefined,
    });
  }

  /** 用 `next` 覆盖当前快照；无变化时跳过写入。 */
  private publish(next: Partial<ScopeSnapshot<T>> & { status: ScopeSnapshot<T>['status'] }): void {
    const current = this.store.getSnapshot();
    const candidate: ScopeSnapshot<T> = {
      status: next.status,
      value: 'value' in next ? next.value : current.value,
      base: 'base' in next ? next.base : current.base,
      user: 'user' in next ? next.user : current.user,
      revision: 'revision' in next ? next.revision : current.revision,
      writable: next.writable ?? current.writable,
      mode: current.mode,
    };
    if (sameSnapshot(candidate as ScopeSnapshot<unknown>, current as ScopeSnapshot<unknown>)) return;
    this.store.set(candidate);
  }

  /** 逐个排队操作；销毁后队列不再产生副作用。操作自身的落地结果按原样回传。 */
  private enqueue(operation: () => Promise<boolean>): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const task = this.tail.then(async () => {
      if (this.disposed) return false;
      return operation();
    });
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 停止排队与推导，并等待在途 wire 调用结束。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.writeGeneration += 1;
    this.unsubscribe?.();
    await this.tail;
  }
}

/**
 * 为一个命名空间构建插件的设置 scope。
 *
 * 订阅两个会推动宿主视图的信号 —— 转发的 `settings/document-updated` 失效事件，
 * 以及（客户端暴露时的）`connection/reset` —— 踢出首读，并在镜像每次变化时推导
 * 命名空间行。
 *
 * `resolveRemote` 是「注入捕获」后的命名空间：`remote.settings` 是 `remote` 下的嵌套
 * 服务，所以必须由拥有 `ctx.inject(['remote.settings'], …)` 的调用方在命名空间落地后
 * 调用 {@link ManagedSettingsScope.refresh}，才能把首次「无命名空间」的读取变成可用
 * 读取；从未挂载该命名空间的 profile 会把设置页留在降级（`unavailable`、只读）状态，
 * 而不是抛错。
 */
export function createSettingsScope<T>(
  context: SettingsScopeContextLike,
  namespace: string,
  resolveRemote: SettingsRemoteResolver,
  timer: SettingsTimer = REAL_SETTINGS_TIMER,
): ManagedSettingsScope<T> {
  const mirror = new SettingsDescribeMirror(resolveRemote, timer);
  const scope = new RemoteSettingsScope<T>(resolveRemote, mirror, namespace);
  const disposers: Array<() => void> = [];

  if (typeof context.remote?.$on === 'function') {
    const off = context.remote.$on('settings/document-updated', () => {
      mirror.ensure();
    });
    if (typeof off === 'function') disposers.push(off);
  }
  if (typeof context.on === 'function') {
    const off = context.on('connection/reset', () => {
      void mirror.load();
    });
    if (typeof off === 'function') disposers.push(off);
  }
  mirror.ensure();

  return {
    getSnapshot: () => scope.getSnapshot(),
    subscribe: (listener) => scope.subscribe(listener),
    set: (field, value) => scope.set(field, value),
    unset: (field) => scope.unset(field),
    refresh: () => {
      void mirror.load();
    },
    dispose: async () => {
      for (const dispose of disposers.splice(0)) dispose();
      mirror.dispose();
      await scope.dispose();
    },
  };
}
