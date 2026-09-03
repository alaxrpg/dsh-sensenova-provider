import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SenseNovaSettingsController,
  parseModelIds,
  type CredentialsFace,
  type SettingsScope,
  type SenseNovaConfig,
  type ScopeSnapshot,
} from '../src/client/settings.ts';

test('parseModelIds: 支持换行/逗号、trim、稳定去重', () => {
  assert.deepEqual(parseModelIds(' a, b\na\n ,c '), ['a', 'b', 'c']);
});

test('SenseNovaSettingsController: 模型选择保存、dirty、discard 与清空 unset', async () => {
  let value: SenseNovaConfig = { modelSelection: { include: ['old'], exclude: ['hidden'] } };
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot(): ScopeSnapshot<SenseNovaConfig> {
      return { status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' };
    },
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
  controller.edit('modelSelectionInclude', ' new, old\nnew ');
  controller.edit('modelSelectionExclude', 'hidden, blocked');
  assert.equal(controller.state().dirty, true);
  await controller.save();
  assert.deepEqual(value.modelSelection, { include: ['new', 'old'], exclude: ['hidden', 'blocked'] });
  assert.equal(controller.state().dirty, false);

  controller.edit('modelSelectionInclude', '');
  controller.edit('modelSelectionExclude', '');
  await controller.save();
  assert.equal(value.modelSelection, undefined);
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
