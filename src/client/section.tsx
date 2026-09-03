/**
 * SenseNova 设置页 React 组件（settings.section slot 内容）。
 * 所有文案经 `t`（settings.sensenova 命名空间）读取，不硬编码。
 */
import { useState } from 'react';
import * as React from 'react';
import { DEFAULT_API_BASE } from './settings';
import type { FieldName, SettingsState, TranslateFn } from './settings';

interface ReactHooks {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initialValue: T): { current: T };
}

const { useEffect, useRef } = React as unknown as ReactHooks;

/** 输入框 change 事件的最小结构（宿主模块表提供真实 React 类型）。 */
interface ChangeEventLike {
  target: { value: string };
}

export interface SenseNovaSectionProps {
  t: TranslateFn;
  /** slots 框架注入的 uSES hook（由 injected.hooks.sensenovaSettings 派生）。 */
  useSensenovaSettings: <S>(selector: (snapshot: SettingsState) => S) => S;
  edit: (field: FieldName, text: string) => void;
  save: () => void;
  discard: () => void;
  addAccount: () => void;
  removeAccount: (id: string) => void;
  editAccountLabel: (id: string, text: string) => void;
  editAccountKey: (id: string, text: string) => void;
  toggleAccountKeyClear: (id: string) => void;
  editDefaultKey: (text: string) => void;
  toggleDefaultKeyClear: () => void;
  setActiveAccount: (id: string) => void;
}

function useSavedFlash(savedCount: number): boolean {
  const [visible, setVisible] = useState(false);
  const previousCount = useRef(savedCount);

  useEffect(() => {
    if (savedCount === previousCount.current) return;
    previousCount.current = savedCount;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2500);
    return () => clearTimeout(timer);
  }, [savedCount]);

  return visible;
}

/** 凭据状态徽标：已配置 / 未配置。 */
function StatusBadge({ configured, t }: { configured: boolean; t: TranslateFn }): JSX.Element {
  return (
    <span className={configured ? 'sn-badge' : 'sn-badgeMuted'}>
      {configured ? t('apiKeySet') : t('apiKeyUnset')}
    </span>
  );
}

function addCredentialReference(refs: Set<string>, value: string): void {
  const normalized = value.trim();
  if (normalized !== '') refs.add(normalized);
}

function credentialReferences(state: SettingsState): ReadonlySet<string> {
  const refs = new Set<string>();
  addCredentialReference(refs, state.apiKeyEnv);
  for (const account of state.accounts) addCredentialReference(refs, account.ref);
  return refs;
}

function isCredentialReference(label: string, refs: ReadonlySet<string>): boolean {
  const value = label.trim();
  if (value === '') return false;
  for (const ref of refs) {
    if (value.includes(ref)) return true;
  }
  return false;
}

function accountDisplayLabel(
  account: { labelDraft: string },
  index: number,
  t: TranslateFn,
  refs: ReadonlySet<string>,
): string {
  const label = account.labelDraft.trim();
  return label !== '' && !isCredentialReference(label, refs)
    ? label
    : t('accountFallback', { index: index + 1 });
}

function AdvancedSettings(props: {
  t: TranslateFn;
  state: SettingsState;
  disabled: boolean;
  edit: (field: FieldName, text: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const customizedCount =
    (props.state.apiBase !== DEFAULT_API_BASE ? 1 : 0) +
    (props.state.modelSelectionInclude.length > 0 ? 1 : 0) +
    (props.state.modelSelectionExclude.length > 0 ? 1 : 0);

  return (
    <div className="sn-card sn-advanced">
      <button
        type="button"
        className="sn-advancedHeader"
        aria-expanded={expanded}
        aria-controls="sn-advanced-settings"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="sn-label">{props.t('advancedSettings')}</span>
        <span className="sn-advancedMeta">
          {customizedCount > 0 ? (
            <span
              className="sn-badgeMuted"
              aria-label={props.t('advancedCustomizedCount', { count: customizedCount })}
            >
              {customizedCount}
            </span>
          ) : null}
          <span
            className={`sn-advancedChevron${expanded ? ' sn-advancedChevronExpanded' : ''}`}
            aria-hidden="true"
          />
        </span>
      </button>

      <div id="sn-advanced-settings" className="sn-advancedBody" hidden={!expanded}>
        <div className="sn-field">
          <label className="sn-label" htmlFor="sn-api-base">
            {props.t('apiBase')}
          </label>
          <input
            id="sn-api-base"
            className="sn-input"
            type="text"
            value={props.state.apiBaseDraft}
            disabled={props.disabled}
            spellCheck={false}
            onChange={(event: ChangeEventLike) => props.edit('apiBase', event.target.value)}
          />
          <p className="sn-hint">{props.t('apiBaseHint')}</p>
        </div>

        <div className="sn-models">
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-model-selection-include">
              {props.t('modelInclude')}
            </label>
            <textarea
              id="sn-model-selection-include"
              className="sn-input sn-textarea"
              rows={4}
              value={props.state.modelSelectionIncludeDraft}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.edit('modelSelectionInclude', event.target.value)}
            />
            <p className="sn-hint">{props.t('modelIncludeHint')}</p>
          </div>
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-model-selection-exclude">
              {props.t('modelExclude')}
            </label>
            <textarea
              id="sn-model-selection-exclude"
              className="sn-input sn-textarea"
              rows={4}
              value={props.state.modelSelectionExcludeDraft}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.edit('modelSelectionExclude', event.target.value)}
            />
            <p className="sn-hint">{props.t('modelExcludeHint')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SenseNovaSection(props: SenseNovaSectionProps): JSX.Element {
  const { t } = props;
  const state = props.useSensenovaSettings((s) => s);
  const disabled = !state.writable;
  const savedVisible = useSavedFlash(state.savedCount);

  const accounts = state.accounts;
  const credentialRefs = credentialReferences(state);
  const savedAccounts = accounts.filter((account) => !account.added);

  return (
    <section className="sn-section" aria-label={t('title')}>
      <h2 className="sn-title">{t('title')}</h2>
      <p className="sn-intro">{t('intro')}</p>
      {!state.writable ? (
        <p className="sn-readOnly" role="status">
          {t('readOnly')}
        </p>
      ) : null}

      {/* Provider 路由信息 */}
      <div className="sn-card">
        <div className="sn-field">
          <div className="sn-fieldHead">
            <span className="sn-label">{t('routeLabel')}</span>
            <span className="sn-badges">
              <span className="sn-badge">{state.route}</span>
            </span>
          </div>
          <p className="sn-hint">
            {state.displayName} · {state.route}
          </p>
        </div>
      </div>

      {/* 默认账户 */}
      <div className="sn-card">
        <DefaultKeyField
          t={t}
          draft={state.defaultKeyDraft}
          disabled={disabled || !state.defaultWritable}
          configured={state.defaultConfigured}
          clearStaged={state.defaultClearStaged}
          onEdit={props.editDefaultKey}
          onToggleClear={props.toggleDefaultKeyClear}
        />
      </div>

      {/* 多账户列表 */}
      <div className="sn-card">
        <div className="sn-field">
          <div className="sn-fieldHead">
            <span className="sn-label">{t('accountsTitle')}</span>
            <button type="button" className="sn-reset" disabled={disabled} onClick={props.addAccount}>
              {t('accountAdd')}
            </button>
          </div>
          <p className="sn-hint">{t('accountsHint')}</p>
        </div>

        {/* 活动账户下拉：自动 + 已保存账户，未保存新增行不参与选择。 */}
        <div className="sn-field">
          <label className="sn-label" htmlFor="sn-active-account">
            {t('activeAccount')}
          </label>
          <div className="sn-activeAccountControl">
            <div className="sn-activeAccountSelect">
               <select
              id="sn-active-account"
              className="sn-input"
              value={state.activeAccountDraft}
              disabled={disabled}
              onChange={(event: ChangeEventLike) => props.setActiveAccount(event.target.value)}
            >
              <option value="">{t('activeAccountAuto')}</option>
              {savedAccounts.map((account, index) => (
                <option key={account.id} value={account.id}>
                  {accountDisplayLabel(account, index, t, credentialRefs)}
                </option>
              ))}
            </select>
               <span className="sn-selectChevron" aria-hidden="true" />
             </div>
            <button
              type="button"
              className="sn-reset"
              disabled={disabled}
              onClick={() => props.setActiveAccount('')}
            >
              {t('activeAccountReset')}
            </button>
          </div>
        </div>

        {accounts.length > 0 ? (
          <div className="sn-accountList">
            {accounts.map((account, index) => (
              <AccountRow
                key={account.id}
                t={t}
                account={account}
                refs={credentialRefs}
                index={index}
                disabled={disabled}
                isActive={state.activeAccountDraft === account.id}
                onRemove={() => props.removeAccount(account.id)}
                onLabel={(text) => props.editAccountLabel(account.id, text)}
                onKey={(text) => props.editAccountKey(account.id, text)}
                onToggleClear={() => props.toggleAccountKeyClear(account.id)}
              />
            ))}
          </div>
        ) : null}
      </div>

      <AdvancedSettings t={t} state={state} disabled={disabled} edit={props.edit} />

      {/* 保存 / 重置 */}
      <div className="sn-footer">
        <div className="sn-footerStatus">
          {state.failed ? (
            <p className="sn-failed" role="status">
              {t('saveFailed')}
            </p>
          ) : null}
          {savedVisible && !state.dirty ? (
            <p className="sn-saved" role="status">
              {t('saved')}
            </p>
          ) : null}
          {state.dirty ? (
            <span className="sn-unsaved">{t('unsaved')}</span>
          ) : null}
        </div>
        <div className="sn-footerActions">
          <button type="button" className="sn-btnGhost" disabled={!state.dirty || state.saving} onClick={props.discard}>
            {t('reset')}
          </button>
          <button type="button" className="sn-btnPrimary" disabled={!state.dirty || state.saving} onClick={props.save}>
            {state.saving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </section>
  );
}

function DefaultKeyField(props: {
  t: TranslateFn;
  draft: string;
  disabled: boolean;
  configured: boolean;
  clearStaged: boolean;
  onEdit: (text: string) => void;
  onToggleClear: () => void;
}): JSX.Element {
  const { t } = props;
  const [visible, setVisible] = useState(false);
  return (
    <div className="sn-field">
      <div className="sn-fieldHead">
        <label className="sn-label" htmlFor="sn-default-key">
          {t('defaultKey')}
        </label>
        <span className="sn-badges">
          <button type="button" className="sn-reset" disabled={props.disabled} onClick={() => setVisible((v) => !v)}>
            {visible ? t('hide') : t('show')}
          </button>
          {props.configured ? (
            <button type="button" className="sn-reset" disabled={props.disabled} onClick={props.onToggleClear}>
              {t('clearKey')}
            </button>
          ) : null}
        </span>
      </div>
      <input
        id="sn-default-key"
        className="sn-input"
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={props.draft}
        disabled={props.disabled}
        onChange={(event: ChangeEventLike) => props.onEdit(event.target.value)}
      />
      <p className="sn-hint">{t('defaultKeyHint')}</p>
    </div>
  );
}

function AccountRow(props: {
  t: TranslateFn;
  account: {
    id: string;
    ref: string;
    labelDraft: string;
    keyDraft: string;
    configured: boolean;
    writable: boolean;
    added: boolean;
    clearStaged: boolean;
  };
  index: number;
  refs: ReadonlySet<string>;
  disabled: boolean;
  isActive: boolean;
  onRemove: () => void;
  onLabel: (text: string) => void;
  onKey: (text: string) => void;
  onToggleClear: () => void;
}): JSX.Element {
  const { t, account } = props;
  const [visible, setVisible] = useState(false);
  const displayLabel = accountDisplayLabel(account, props.index, t, props.refs);
  const labelDraft = isCredentialReference(account.labelDraft, props.refs) ? '' : account.labelDraft;
  const labelId = `sn-account-label-${account.id}`;
  const keyId = `sn-account-key-${account.id}`;

  return (
    <div className="sn-accountRow">
      <div className="sn-accountHead">
        <span className="sn-label" title={displayLabel}>{displayLabel}</span>
        <span className="sn-accountActions">
          <span className="sn-badges">
            <StatusBadge configured={account.configured} t={t} />
            {props.isActive ? (
              <span className="sn-badge sn-badgeActive">{t('activeBadge')}</span>
            ) : null}
          </span>
          <button
            type="button"
            className="sn-reset"
            disabled={props.disabled || !account.writable}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? t('hide') : t('show')}
          </button>
          {account.configured ? (
            <button
              type="button"
              className="sn-reset"
              disabled={props.disabled || !account.writable}
              onClick={props.onToggleClear}
            >
              {t('clearKey')}
            </button>
          ) : null}
          <button type="button" className="sn-reset" disabled={props.disabled} onClick={props.onRemove}>
            {t('accountRemove')}
          </button>
        </span>
      </div>
      <div className="sn-accountFields">
        <input
          id={labelId}
          className="sn-input"
          type="text"
          placeholder={t('accountLabel')}
          aria-label={t('accountLabel')}
          value={labelDraft}
          disabled={props.disabled}
          spellCheck={false}
          onChange={(event: ChangeEventLike) => props.onLabel(event.target.value)}
        />
        <div className="sn-accountKeyRow">
          <input
            id={keyId}
            className="sn-input"
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            placeholder={t('accountKey')}
            aria-label={t('accountKey')}
            spellCheck={false}
            value={account.keyDraft}
            disabled={props.disabled || !account.writable}
            onChange={(event: ChangeEventLike) => props.onKey(event.target.value)}
          />
          <p className="sn-hint">{t('accountKeyHint')}</p>
        </div>
      </div>
    </div>
  );
}
