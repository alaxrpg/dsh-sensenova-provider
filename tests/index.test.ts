import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_API_BASE,
  DEFAULT_API_KEY_ENV,
  inject,
  resolveAdapterOptions,
} from '../src/index.ts';

test('host plugin declares the credentials dependency for initial model-catalog loading', () => {
  assert.deepEqual(inject, ['llm', 'credentials']);
});

test('resolveAdapterOptions: blank apiKeyEnv/apiBase fall back to safe defaults', () => {
  const resolved = resolveAdapterOptions({ apiKeyEnv: '  ', apiBase: '   ' });
  assert.equal(resolved.accounts[0]?.ref, DEFAULT_API_KEY_ENV);
  assert.equal(resolved.apiBase, DEFAULT_API_BASE);
});
