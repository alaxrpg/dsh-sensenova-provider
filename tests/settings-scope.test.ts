/**
 * `remote.settings` wire scope 的行为测试。
 *
 * 覆盖本次 0.1.7 迁移的关键路径：首读与重试阶梯、命名空间缺失的降级、
 * set/unset 的 op 形状与 revision 栅栏、宿主拒绝后的恢复读取、以及 dispose 后静默。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSettingsScope,
  type SettingsDocumentView,
  type SettingsNamespaceView,
  type SettingsOp,
  type SettingsRemoteNamespace,
  type SettingsRemoteResponse,
  type SettingsTimer,
} from '../src/client/settings-scope.ts';
import type { SenseNovaConfig } from '../src/client/settings.ts';

const NS = 'llm-sensenova';

/** 可控的假宿主：记录 describe/mutate 调用，并允许逐次定制应答。 */
class FakeRemote implements SettingsRemoteNamespace {
  describes = 0;
  mutations: Array<{ ns: string; ops: SettingsOp[]; revision?: number }> = [];
  view: SettingsDocumentView = {
    writable: true,
    namespaces: [{ ns: NS, value: { apiBase: 'https://a/v1' }, base: {}, user: {}, revision: 7 }],
  };
  describeImpl: (() => Promise<SettingsRemoteResponse<SettingsDocumentView>>) | undefined;
  mutateImpl: ((ns: string, ops: SettingsOp[], revision?: number) => Promise<SettingsRemoteResponse<SettingsNamespaceView>>) | undefined;

  async describe(): Promise<SettingsRemoteResponse<SettingsDocumentView>> {
    this.describes += 1;
    if (this.describeImpl !== undefined) return this.describeImpl();
    return { ok: true, value: this.view };
  }

  async mutate(ns: string, ops: SettingsOp[], revision?: number): Promise<SettingsRemoteResponse<SettingsNamespaceView>> {
    this.mutations.push({ ns, ops, revision });
    if (this.mutateImpl !== undefined) return this.mutateImpl(ns, ops, revision);
    const row = this.view.namespaces?.[0];
    return { ok: true, value: { ...(row ?? { ns }), revision: (row?.revision ?? 0) + 1 } };
  }
}

/** 可手动推进的假定时器。 */
class FakeTimer implements SettingsTimer {
  scheduled: Array<{ callback: () => void; ms: number; handle: number }> = [];
  cleared: number[] = [];
  private next = 1;

  set(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.scheduled.push({ callback, ms, handle });
    return handle;
  }

  clear(handle: unknown): void {
    this.cleared.push(handle as number);
  }

  fireLast(): void {
    const entry = this.scheduled.pop();
    assert.ok(entry !== undefined, '存在待触发的重试');
    entry.callback();
  }
}

function fakeContext() {
  const disposers: Array<() => void> = [];
  return {
    ctx: {
      remote: {
        $on(_event: string, _listener: () => void) {
          const off = () => {};
          disposers.push(off);
          return off;
        },
      },
      on(_event: string, _listener: () => void) {
        const off = () => {};
        disposers.push(off);
        return off;
      },
    },
    disposers,
  };
}

/** 等到微任务/宏任务清空，让在途的 describe 落定。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('settings-scope: 命名空间挂载后首读就绪，快照带 value/writable/revision', async () => {
  const remote = new FakeRemote();
  let namespace: SettingsRemoteNamespace | undefined;
  const { ctx } = fakeContext();
  const scope = createSettingsScope<SenseNovaConfig>(ctx, NS, () => namespace);

  // 命名空间尚未挂载：保持 loading，不抛错。
  assert.equal(scope.getSnapshot().status, 'loading');
  assert.equal(scope.getSnapshot().writable, false);

  namespace = remote;
  scope.refresh();
  await settle();

  const snapshot = scope.getSnapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.writable, true);
  assert.deepEqual(snapshot.value, { apiBase: 'https://a/v1' });
  assert.equal(snapshot.revision, 7);
  await scope.dispose();
});

test('settings-scope: set/unset 发出对应 op，并带上 describe 返回的 revision', async () => {
  const remote = new FakeRemote();
  const { ctx } = fakeContext();
  const scope = createSettingsScope<SenseNovaConfig>(ctx, NS, () => remote);
  await settle();

  const accepted = await scope.set('quotaRotation', true);
  assert.equal(accepted, true);
  assert.deepEqual(remote.mutations[0], {
    ns: NS,
    ops: [{ op: 'set', path: ['quotaRotation'], value: true }],
    revision: 7,
  });

  await scope.unset('apiBase');
  assert.deepEqual(remote.mutations[1]?.ops, [{ op: 'unset', path: ['apiBase'] }]);

  // 写入应答经 acceptView 折进镜像：写后立即热生效，无需再次 describe。
  const snapshot = scope.getSnapshot();
  assert.equal(snapshot.revision, 8);
  assert.equal(remote.describes, 1, '写入不应触发额外 describe');
  await scope.dispose();
});

test('settings-scope: 宿主拒绝时重读宿主并返回 false（不静默冒充成功）', async () => {
  const remote = new FakeRemote();
  const { ctx } = fakeContext();
  const scope = createSettingsScope<SenseNovaConfig>(ctx, NS, () => remote);
  await settle();
  const describesBefore = remote.describes;

  remote.mutateImpl = async () => ({ ok: false, error: { code: 'settings/conflict', message: 'changed since read' } });
  const accepted = await scope.set('apiBase', 'https://b/v1');
  await settle();

  assert.equal(accepted, false, '冲突写入报告未落地');
  assert.equal(remote.describes, describesBefore + 1, '拒绝后重读宿主');
  assert.deepEqual(scope.getSnapshot().value, { apiBase: 'https://a/v1' }, '快照仍是宿主事实');
  await scope.dispose();
});

test('settings-scope: 宿主不提供该命名空间时降级为 unavailable 且只读', async () => {
  const remote = new FakeRemote();
  remote.view = { writable: false, namespaces: [{ ns: 'other-ns', value: {}, revision: 1 }] };
  const { ctx } = fakeContext();
  const scope = createSettingsScope<SenseNovaConfig>(ctx, NS, () => remote);
  await settle();

  const snapshot = scope.getSnapshot();
  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.writable, false);
  await scope.dispose();
});

test('settings-scope: 首读失败按有界阶梯重试，成功后不再重试', async () => {
  const remote = new FakeRemote();
  const timer = new FakeTimer();
  let failing = true;
  remote.describeImpl = async () => {
    if (failing) throw new Error('host not up');
    return { ok: true, value: remote.view };
  };
  const { ctx } = fakeContext();
  const scope = createSettingsScope<SenseNovaConfig>(ctx, NS, () => remote, timer);
  await settle();

  assert.equal(scope.getSnapshot().status, 'loading', '一无所获的失败保持 loading');
  assert.deepEqual(timer.scheduled.map((entry) => entry.ms), [1000], '首读失败排入 1s 重试');

  failing = false;
  timer.fireLast();
  await settle();
  assert.equal(scope.getSnapshot().status, 'ready');
  assert.deepEqual(timer.scheduled, [], '成功后不再安排重试');
  await scope.dispose();
});

test('settings-scope: dispose 后写入与重试都静默', async () => {
  const remote = new FakeRemote();
  const timer = new FakeTimer();
  const { ctx } = fakeContext();
  const scope = createSettingsScope<SenseNovaConfig>(ctx, NS, () => remote, timer);
  await settle();

  await scope.dispose();
  const mutationsBefore = remote.mutations.length;
  const accepted = await scope.set('apiBase', 'https://c/v1');
  assert.equal(accepted, false, '销毁后的写入不落地');
  assert.equal(remote.mutations.length, mutationsBefore, '销毁后不再发起 wire 写入');
});
