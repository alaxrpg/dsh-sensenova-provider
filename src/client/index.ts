/**
 * SenseNova 客户端插件入口（browser half）。
 *
 * 只做多账户连接配置所必需的事：
 *   1. 注册 `settings.sensenova` 文案命名空间（zh/en）；
 *   2. 桥接凭据面：优先宿主 `remote.credentials`，旧版退化为
 *      `connection.api.credentials`（与 @mars-sea/dsh-commandcode-provider 同构）；
 *   3. 用 `settingsScope.bind({ namespace: 'llm-sensenova' })` 生成设置域，
 *      交给 SenseNovaSettingsController（领域层，无 JSX）；
 *   4. 注入 `settings.section`（设置页）与 `settings.models.provider-card`
 *      （Models 页卡片）两个槽。
 *
 * API key 一律经凭据域写入（credential-ref），页面不回显明文；host 是唯一事实
 * 来源，保存后立即热生效。
 */
import { SenseNovaSection } from './section';
import { SenseNovaProviderCard } from './card';
import {
  SENSENOVA_NS,
  createSnapshotStore,
  SenseNovaSettingsController,
  type CredentialsFace,
  type SettingsScope,
  type SenseNovaConfig,
} from './settings';
import { zh, en } from './locales';

/** 旧版 ApiProxy 凭据面（仅作退化路径）。 */
interface LegacyCredentialApi {
  describe(input: { refs: string[] }): Promise<{ result: { ok: boolean; value?: { credentials: Record<string, { configured: boolean; writable: boolean }> }; error?: unknown } }>;
  set(input: { ref: string; value: string }): Promise<{ result: { ok: boolean; error?: unknown } }>;
  unset(input: { ref: string }): Promise<{ result: { ok: boolean; error?: unknown } }>;
}

/** 最小 Cordis 上下文面，避免依赖缺失的 ui-slots / ui-primitives 包做类型检查。 */
interface ClientContextLike {
  slots: {
    inject(key: string, factory: () => () => void): () => void;
    register(options: unknown, component: unknown): unknown;
  };
  locale: {
    register(namespace: string, table: { zh: Record<string, string>; en: Record<string, string> }): void;
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string;
  };
  connection?: {
    api?: { credentials?: LegacyCredentialApi };
  };
  remote: {
    credentials: CredentialsFace;
    $on(event: string, listener: () => void): () => void;
  };
  settingsScope: {
    bind(spec: { namespace: string }): SettingsScope<SenseNovaConfig>;
  };
  get(name: string): unknown;
  effect(fn: () => (() => void) | void, label: string): void;
  inject(deps: string[], fn: (ctx: ClientContextLike) => void): void;
}

/** 把旧版 ApiProxy 凭据面适配为 CredentialsFace。 */
function adaptLegacyCredentials(legacy: LegacyCredentialApi | undefined): CredentialsFace | undefined {
  if (legacy === undefined) return undefined;
  return {
    describe: async (refs) => {
      const response = await legacy.describe({ refs });
      if (!response.result.ok) return { ok: false as const };
      const value = response.result.value?.credentials;
      return value === undefined ? { ok: true as const } : { ok: true as const, value };
    },
    set: async (ref, value) => {
      const response = await legacy.set({ ref, value });
      return response.result.ok ? { ok: true } : { ok: false, error: response.result.error };
    },
    unset: async (ref) => {
      const response = await legacy.unset({ ref });
      return response.result.ok ? { ok: true } : { ok: false, error: response.result.error };
    },
  };
}

function injectPageCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('dsh-sensenova-provider-css')) return;
  const tag = document.createElement('style');
  tag.id = 'dsh-sensenova-provider-css';
  tag.textContent = [
    '.sn-section{display:flex;flex-direction:column;gap:12px}',
    '.sn-title{font-size:16px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,#222)}',
    '.sn-intro,.sn-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin:2px 0 0}',
    '.sn-readOnly,.sn-failed{font-size:12px;color:var(--dsw-alias-label-error,#d9534f);margin:0}',
    '.sn-saved{font-size:12px;color:var(--dsw-alias-label-success,#2e8b57);margin:0}',
    '.sn-unsaved{font-size:12px;color:var(--dsw-alias-label-warning,#b58900);margin:0}',
    '.sn-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,#333);border-radius:8px;padding:12px;background:var(--dsw-alias-bg-layer-1,transparent)}',
    '.sn-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
    '.sn-fieldHead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}',
    '.sn-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#222);min-width:0}',
    '.sn-badges{display:inline-flex;gap:6px;align-items:center;flex:0 0 auto;min-width:0;white-space:nowrap}',
    '.sn-badge,.sn-badgeMuted,.sn-badgeActive{font-size:11px;padding:1px 8px;border-radius:999px;white-space:nowrap;line-height:17px}',
    '.sn-badge{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,#5c5c5c);font-weight:500}',
    '.sn-badgeMuted{background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a)}',
    '.sn-badgeActive{background:var(--dsw-alias-brand-primary-weak,rgba(59,130,246,.12));color:var(--dsw-alias-brand-primary,#3b82f6);font-weight:500}',
    '.sn-input{box-sizing:border-box;width:100%;font-size:13px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#222);min-width:0}',
    '.sn-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}',
    'select.sn-input{appearance:none;cursor:pointer;padding-right:30px}',
     '.sn-activeAccountSelect{position:relative;flex:1 1 auto;min-width:0}',
     '.sn-activeAccountSelect>.sn-input{width:100%}',
     '.sn-selectChevron{position:absolute;right:8px;top:50%;width:14px;height:14px;transform:translateY(-50%);background-color:var(--dsw-alias-label-tertiary,#888f98);pointer-events:none;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 14 14%27 fill=%27none%27%3E%3Cpath d=%27M3 5.5 7 9l4-3.5%27 stroke=%27white%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E") center / 14px 14px no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 14 14%27 fill=%27none%27%3E%3Cpath d=%27M3 5.5 7 9l4-3.5%27 stroke=%27white%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E") center / 14px 14px no-repeat}',
    '.sn-textarea{display:block;line-height:1.45;min-height:88px;resize:vertical}',
    '.sn-accountList{display:flex;flex-direction:column;gap:0;min-width:0}',
    '.sn-accountRow{display:flex;flex-direction:column;gap:8px;min-width:0;padding:2px 0 12px}',
    '.sn-accountRow+.sn-accountRow{border-top:1px solid var(--dsw-alias-border-l2,#333);padding-top:12px}',
    '.sn-accountHead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:nowrap}',
    '.sn-accountHead>.sn-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sn-accountActions{display:flex;align-items:center;gap:8px;flex:0 0 auto;min-width:0;white-space:nowrap}',
    '.sn-accountFields{display:flex;flex-direction:column;gap:8px;min-width:0}',
    '.sn-accountFields>.sn-input{width:100%}',
    '.sn-accountKeyRow{display:flex;flex-direction:column;gap:4px;min-width:0}',
    '.sn-accountKeyRow>.sn-input{width:100%}',
    '.sn-activeAccountControl{display:flex;align-items:center;gap:8px;min-width:0}',
    
    '.sn-reset{font-size:12px;line-height:1.4;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);cursor:pointer;white-space:nowrap}',
    '.sn-reset:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#3b82f6)}',
    '.sn-reset:disabled{opacity:.5;cursor:not-allowed}',
    '.sn-btnPrimary{font-size:13px;line-height:1.4;padding:6px 12px;border-radius:6px;border:1px solid transparent;background:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-label-primary,#fff);cursor:pointer}',
    '.sn-btnPrimary:hover:not(:disabled){filter:brightness(.94)}',
    '.sn-btnPrimary:disabled{opacity:.5;cursor:not-allowed}',
     '.sn-btnGhost{font-size:13px;line-height:1.4;padding:6px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#444);background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);cursor:pointer}',
     '.sn-btnGhost:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6)}',
     '.sn-btnGhost:disabled{opacity:.5;cursor:not-allowed}',
    '.sn-footer{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-end;gap:8px}',
     '.sn-footerStatus{display:flex;flex-direction:column;gap:2px}',
     '.sn-footerActions{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
    '.sn-advanced{gap:0;padding:0;overflow:hidden}',
    '.sn-advancedHeader{display:flex;align-items:center;width:100%;gap:8px;padding:12px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;text-align:left;cursor:pointer}',
    '.sn-advancedHeader:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08))}',
    '.sn-advancedHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-2px}',
    '.sn-advancedMeta{display:inline-flex;align-items:center;gap:8px;margin-left:auto;white-space:nowrap}',
    '.sn-advancedChevron{width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-tertiary,#888f98);border-bottom:1.5px solid var(--dsw-alias-label-tertiary,#888f98);transform:rotate(45deg);transition:transform .15s ease}',
    '.sn-advancedChevronExpanded{transform:rotate(225deg)}',
    '.sn-advancedBody{display:flex;flex-direction:column;gap:10px;padding:0 12px 12px;border-top:1px solid var(--dsw-alias-border-l2,#333);min-width:0}',
    '.sn-advancedBody[hidden]{display:none}',
    '.sn-models{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,#333);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}',
    '.sn-providerCard{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,#333);border-radius:8px;padding:12px;background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}',
  ].join('\n');
  document.head.appendChild(tag);
}

/** 在给定的 ctx 上挂载两个槽，共享同一个设置控制器与快照 store。 */
function applyClientSurfaces(ctx: ClientContextLike, credentials: CredentialsFace): void {
  const scope = ctx.settingsScope.bind({ namespace: SENSENOVA_NS });
  const controller = new SenseNovaSettingsController(scope, credentials);
  ctx.effect(() => () => controller.dispose(), 'dsh-sensenova-provider: settings controller');

  const store = createSnapshotStore(controller.state());
  controller.subscribe(() => store.set(controller.state()));

  // 宿主的凭据域提交（set/unset/外部编辑）后重读配置状态，刷新「已配置/可写」徽标。
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', () => {
    void controller.refreshCredentials();
  }), 'dsh-sensenova-provider: credential invalidations');

  const injected = () => ({
    hooks: { sensenovaSettings: store },
    edit: (field: Parameters<SenseNovaSettingsController['edit']>[0], text: string) => controller.edit(field, text),
    save: () => void controller.save(),
    discard: () => controller.discard(),
    addAccount: () => controller.addAccount(),
    removeAccount: (id: string) => controller.removeAccount(id),
    editAccountLabel: (id: string, text: string) => controller.editAccountLabel(id, text),
    editAccountKey: (id: string, text: string) => controller.editAccountKey(id, text),
    toggleAccountKeyClear: (id: string) => controller.toggleAccountKeyClear(id),
    editDefaultKey: (text: string) => controller.editDefaultKey(text),
    toggleDefaultKeyClear: () => controller.toggleDefaultKeyClear(),
    setActiveAccount: (id: string) => controller.setActiveAccount(id),
  });

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sensenova',
    order: 13,
    label: () => ctx.locale.bind('settings.sensenova')('nav'),
    locale: 'settings.sensenova',
    inject: injected,
  }, SenseNovaSection) as () => void);

  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: 'llm-sensenova',
    locale: 'settings.sensenova',
    inject: () => ({
      hooks: { sensenovaSettings: store },
      edit: (field: Parameters<SenseNovaSettingsController['edit']>[0], text: string) => controller.edit(field, text),
      save: () => void controller.save(),
    }),
  }, SenseNovaProviderCard) as () => void);
}

export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope'];

export function apply(ctx: ClientContextLike): void {
  injectPageCss();
  ctx.effect(() => ctx.locale.register('settings.sensenova', { zh, en }), 'dsh-sensenova-provider: page copy');

  const legacy = adaptLegacyCredentials(ctx.connection?.api?.credentials);
  if (legacy !== undefined) {
    applyClientSurfaces(ctx, legacy);
    return;
  }
  ctx.inject(['remote.credentials'], (remoteCtx) => {
    applyClientSurfaces(remoteCtx, remoteCtx.remote.credentials);
  });
}
