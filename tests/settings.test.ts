import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SenseNovaSettingsController,
  type CredentialsFace,
  type SettingsScope,
  type SenseNovaConfig,
  type ScopeSnapshot,
} from '../src/client/settings.ts';

test('SenseNovaSettingsController: quotaRotation 缺省关、staged 保存热生效与 discard', async () => {
  let value: SenseNovaConfig = {};
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  };
  const credentials: CredentialsFace = {
    describe: async () => ({ ok: true, value: {} }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controller = new SenseNovaSettingsController(scope, credentials);
  assert.equal(controller.state().quotaRotation, false, '缺省关闭');
  assert.equal(controller.state().quotaRotationDraft, false);
  assert.equal(controller.state().dirty, false);

  // staged 开启：展示值立即变化，生效值在保存前不变。
  controller.setQuotaRotation(true);
  assert.equal(controller.state().dirty, true);
  assert.equal(controller.state().quotaRotationDraft, true, 'staged 立即反映到展示值');
  assert.equal(controller.state().quotaRotation, false, '保存前生效值不变');

  await controller.save();
  assert.equal(value.quotaRotation, true, '经 settings 命名空间持久化');
  assert.equal(controller.state().quotaRotation, true, '保存即热生效');
  assert.equal(controller.state().dirty, false);

  // 可再次关闭（保存 false，而非 unset——默认即 false）。
  controller.setQuotaRotation(false);
  await controller.save();
  assert.equal(value.quotaRotation, false, '再次关闭并持久化');

  // discard 丢弃 staged 编辑，不影响已保存值。
  controller.setQuotaRotation(true);
  controller.discard();
  assert.equal(controller.state().quotaRotationDraft, false, '丢弃 staged');
  assert.equal(controller.state().dirty, false);
  assert.equal(value.quotaRotation, false);

  // 存储值为非法类型时归一化为默认关闭。
  value = { quotaRotation: 'yes' as unknown as boolean };
  for (const listener of listeners) listener();
  assert.equal(controller.state().quotaRotation, false, '非布尔存储值回退默认关');
  controller.dispose();
});

test('SenseNovaSettingsController: 删除当前活动账户会同步 staged activeAccount 并保存 unset', async () => {
  let value: SenseNovaConfig = {
    accounts: [{ id: 'account-2', label: 'Secondary', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
    activeAccount: 'account-2',
  };
  const unsetFields: string[] = [];
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      unsetFields.push(field);
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  };
  const credentials: CredentialsFace = {
    describe: async () => ({ ok: true, value: {} }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controller = new SenseNovaSettingsController(scope, credentials);
  controller.removeAccount('account-2');
  assert.equal(controller.state().activeAccountDraft, '');
  await controller.save();
  assert.ok(unsetFields.includes('activeAccount'));
  assert.equal(value.activeAccount, undefined);
  assert.deepEqual(value.accounts, []);
  controller.dispose();
});

test('SenseNovaSettingsController: credential-ref trim/校验阻止非法引用进入 credentials 或配置', async () => {
  let value: SenseNovaConfig = {
    apiKeyEnv: ' VALID_REF ',
    accounts: [{ id: 'bad', label: 'Bad', apiKeyEnv: ' invalid ref ' }],
  };
  const calls = { describe: 0, set: 0, unset: 0 };
  const describedRefs: string[][] = [];
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  };
  const credentials: CredentialsFace = {
    describe: async (refs) => { calls.describe += 1; describedRefs.push([...refs]); return { ok: true, value: {} }; },
    set: async () => { calls.set += 1; return { ok: true }; },
    unset: async () => { calls.unset += 1; return { ok: true }; },
  };
  const controller = new SenseNovaSettingsController(scope, credentials);
  await Promise.resolve();
  const initialDescribe = calls.describe;
  assert.deepEqual(describedRefs[describedRefs.length - 1], ['VALID_REF']);
  assert.deepEqual(controller.storedAccounts(), []);

  controller.edit('apiKeyEnv', ' invalid ref ');
  await controller.refreshCredentials();
  assert.equal(calls.describe, initialDescribe);
  await controller.save();
  assert.equal(value.apiKeyEnv, ' VALID_REF ');
  assert.equal(calls.set, 0);
  assert.equal(calls.unset, 0);
  assert.equal(controller.state().failed, true);

  controller.discard();
  controller.edit('apiKeyEnv', '  VALID_REF  ');
  await controller.save();
  assert.equal(value.apiKeyEnv, 'VALID_REF');
  assert.equal(calls.set, 0);
  assert.equal(calls.unset, 0);
  controller.dispose();
});

test('SenseNovaSettingsController: 并发上限 staged 保存与非法值回退 1', async () => {
  let value: SenseNovaConfig = {};
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  };
  const credentials: CredentialsFace = {
    describe: async () => ({ ok: true, value: {} }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controller = new SenseNovaSettingsController(scope, credentials);
  assert.equal(controller.state().concurrency, 1, '缺省并发上限 1');
  assert.equal(controller.state().concurrencyDraft, '1');

  controller.edit('concurrency', '4');
  assert.equal(controller.state().dirty, true);
  assert.equal(controller.state().concurrencyDraft, '4');
  await controller.save();
  assert.equal(value.concurrency, 4, '合法正整数保存');

  controller.edit('concurrency', '0');
  await controller.save();
  assert.equal(value.concurrency, 1, '非法值（0）保存时回退 1');
  controller.dispose();
});

test('SenseNovaSettingsController: effectiveActiveAccountId 派生', async () => {
  let value: SenseNovaConfig = {};
  // 默认账户（SENSENOVA_API_KEY）的配置状态按场景切换；额外账户恒为已配置。
  let defaultConfigured = true;
  const listeners = new Set<() => void>();
  const scope = (): SettingsScope<SenseNovaConfig> => ({
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  });
  const credentials: CredentialsFace = {
    describe: async (refs) => ({
      ok: true,
      value: Object.fromEntries(refs.map((ref) => [
        ref,
        { configured: ref === 'SENSENOVA_API_KEY' ? defaultConfigured : true, writable: true },
      ])),
    }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controller = new SenseNovaSettingsController(scope(), credentials);
  await controller.refreshCredentials();
  // 默认账户已配置、无额外账户 → 'default'
  assert.equal(controller.state().effectiveActiveAccountId, 'default', '默认账户已配置时自动取 default');

  // 默认未配置、第一个账户已配置 → 该账户 id
  defaultConfigured = false;
  value = { accounts: [{ id: 'account-2', label: 'Secondary', apiKeyEnv: 'SENSENOVA_API_KEY_2' }] };
  await controller.refreshCredentials();
  assert.equal(controller.state().effectiveActiveAccountId, 'account-2', '默认未配置时取第一个已配置账户');

  // 钉选账户：activeAccount 指向已配置账户 → 该 id
  value = {
    accounts: [{ id: 'account-2', label: 'Secondary', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
    activeAccount: 'account-2',
  };
  await controller.refreshCredentials();
  assert.equal(controller.state().effectiveActiveAccountId, 'account-2', '钉选账户生效');

  // 全未配置 → ''
  defaultConfigured = false;
  value = { accounts: [{ id: 'account-2', label: 'Secondary', apiKeyEnv: 'SENSENOVA_API_KEY_2' }] };
  const credentialsNone: CredentialsFace = {
    describe: async (refs) => ({
      ok: true,
      value: Object.fromEntries(refs.map((ref) => [ref, { configured: false, writable: true }])),
    }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controllerNone = new SenseNovaSettingsController(scope(), credentialsNone);
  await controllerNone.refreshCredentials();
  assert.equal(controllerNone.state().effectiveActiveAccountId, '', '无已配置账户时为空');
  controller.dispose();
  controllerNone.dispose();
});

test('SenseNovaSettingsController: 快照延迟就绪后重查凭据，额外账户徽标反映真实配置', async () => {
  const describeCalls: string[][] = [];
  let value: SenseNovaConfig | undefined = undefined;
  let status: ScopeSnapshot<SenseNovaConfig>['status'] = 'loading';
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status, value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set() {},
    async unset() {},
  };
  const credentials: CredentialsFace = {
    describe: async (refs) => {
      describeCalls.push(refs);
      const configured: Record<string, boolean> = {
        SENSENOVA_API_KEY: true,
        SENSENOVA_API_KEY_2: true,
      };
      return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: configured[ref] ?? false, writable: true }])) };
    },
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };

  // 构造时快照仍为 loading：accounts 不可见，首轮 describe 只含默认 ref。
  const controller = new SenseNovaSettingsController(scope, credentials);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.state().available, false);
  assert.deepEqual(describeCalls.at(-1), ['SENSENOVA_API_KEY']);

  // 宿主快照就绪：accounts 可见，订阅回调触发 refs 集合对比并重查。
  status = 'ready';
  value = { accounts: [{ id: 'account-2', label: '账户 2', apiKeyEnv: 'SENSENOVA_API_KEY_2' }] };
  for (const listener of listeners) listener();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const account = controller.state().accounts.find((a) => a.id === 'account-2');
  assert.ok(account, '账户 2 行存在');
  assert.equal(account.configured, true, '快照就绪后徽标为已配置');
  assert.deepEqual([...(describeCalls.at(-1) ?? [])].sort(), ['SENSENOVA_API_KEY', 'SENSENOVA_API_KEY_2']);
  controller.dispose();
});
