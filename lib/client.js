window.__ModuleLoader__.load({
	id: "@alaxrpg/dsh-sensenova-provider",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/settings.ts
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
		const SENSENOVA_NS = "llm-sensenova";
		const SENSENOVA_ROUTE = "sensenova";
		const SENSENOVA_DISPLAY_NAME = "SenseNova";
		/** 默认 apiBase 与默认凭据环境变量。 */
		const DEFAULT_API_BASE = "https://token.sensenova.cn/v1";
		const DEFAULT_API_KEY_ENV = "SENSENOVA_API_KEY";
		/** 把并发上限输入归一化为正整数（非法/无法解析回退默认 1）。 */
		function normalizeConcurrency(value) {
			if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
			if (typeof value === "string") {
				const parsed = Number.parseInt(value.trim(), 10);
				if (Number.isInteger(parsed) && parsed >= 1) return parsed;
			}
			return 1;
		}
		/** 把 quotaRotation 存储值归一化为布尔（仅严格 true 视为开，其余回退默认关）。 */
		function normalizeQuotaRotation(value) {
			return value === true ? true : false;
		}
		/** 创建一个小型可观察快照 store（参考实现的 createSnapshotStore 精简版）。 */
		function createSnapshotStore(initial) {
			let snapshot = initial;
			const listeners = /* @__PURE__ */ new Set();
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
					for (const listener of [...listeners]) try {
						listener();
					} catch (error) {
						console.error("[dsh-sensenova-provider] snapshot subscriber failed:", error);
					}
				}
			};
		}
		/** 与宿主 credentials 的 canonical credential-ref 规则一致（POSIX shell 标识符）。 */
		const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
		function canonicalCredentialRef(value) {
			if (typeof value !== "string") return void 0;
			const trimmed = value.trim();
			return trimmed !== "" && CREDENTIAL_REF_PATTERN.test(trimmed) ? trimmed : void 0;
		}
		/** 从 section 值中读取凭据引用；未配置时回退默认，非法值则视为无凭据。 */
		function credentialRefOf(apiKeyEnv) {
			if (apiKeyEnv === void 0) return DEFAULT_API_KEY_ENV;
			return canonicalCredentialRef(apiKeyEnv);
		}
		/** 从 section 值中读取 apiBase（空则回退默认）。 */
		function apiBaseOf(apiBase) {
			return typeof apiBase === "string" && apiBase.length > 0 ? apiBase : DEFAULT_API_BASE;
		}
		/** 从 section 值中解析 stored accounts（过滤非法条目）。 */
		function storedAccountsOf(raw) {
			if (!Array.isArray(raw)) return [];
			const out = [];
			for (const entry of raw) {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
				const record = entry;
				const id = record.id;
				const label = record.label;
				const apiKeyEnv = canonicalCredentialRef(record.apiKeyEnv);
				if (apiKeyEnv === void 0) continue;
				out.push({
					id: typeof id === "string" && id.trim() !== "" ? id.trim() : apiKeyEnv,
					label: typeof label === "string" && label.trim() !== "" ? label.trim() : apiKeyEnv,
					apiKeyEnv
				});
			}
			return out;
		}
		var SenseNovaSettingsController = class {
			scope;
			credentials;
			stagedApiBase;
			stagedApiKeyEnv;
			stagedActiveAccount;
			stagedConcurrency;
			stagedQuotaRotation;
			defaultKeyDraft = "";
			defaultClearStaged = false;
			addedAccounts = [];
			removedIds = /* @__PURE__ */ new Set();
			labelDrafts = /* @__PURE__ */ new Map();
			keyDrafts = /* @__PURE__ */ new Map();
			keyClears = /* @__PURE__ */ new Set();
			credentialStates = /* @__PURE__ */ new Map();
			/** 上一次成功 describeAll 查询过的 refs 集合键（去重排序拼接）；用于检测快照替换引入的新 ref。 */
			describedRefsKey = "";
			saving = false;
			failed = false;
			savedCount = 0;
			listeners = /* @__PURE__ */ new Set();
			disposers = [];
			disposed = false;
			constructor(scope, credentials) {
				this.scope = scope;
				this.credentials = credentials;
				this.disposers.push(scope.subscribe(() => {
					this.publish();
					this.describeIfRefsChanged();
				}));
				this.describeAll();
			}
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				for (const dispose of this.disposers) dispose();
				this.disposers.length = 0;
				this.listeners.clear();
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			/** 默认账户的凭据引用：优先 staged 草稿，其次 section 值，最后回退默认。 */
			credentialRef() {
				return credentialRefOf(this.stagedApiKeyEnv ?? this.sectionValue("apiKeyEnv"));
			}
			storedAccounts() {
				return storedAccountsOf(this.sectionValue("accounts"));
			}
			/** 当前 section 值（快照未就绪时 undefined）。 */
			sectionValue(field) {
				return this.scope.getSnapshot().value?.[field];
			}
			/** 页面状态面。 */
			state() {
				const snapshot = this.scope.getSnapshot();
				const ref = this.credentialRef();
				const defaultView = ref === void 0 ? void 0 : this.credentialStates.get(ref);
				const accounts = this.effectiveAccounts();
				const apiBase = apiBaseOf(this.sectionValue("apiBase"));
				const apiKeyEnv = credentialRefOf(this.sectionValue("apiKeyEnv")) ?? "";
				const activeAccount = typeof this.sectionValue("activeAccount") === "string" ? this.sectionValue("activeAccount") : "";
				const concurrency = normalizeConcurrency(this.sectionValue("concurrency"));
				const quotaRotation = normalizeQuotaRotation(this.sectionValue("quotaRotation"));
				const effectiveActiveAccountId = this.effectiveActiveAccountId(activeAccount, defaultView?.configured ?? false);
				const effectiveActiveAccountLabel = this.effectiveActiveAccountLabel(effectiveActiveAccountId, accounts);
				const configuredCount = (defaultView?.configured ? 1 : 0) + accounts.filter((a) => a.configured).length;
				const totalCount = 1 + accounts.filter((a) => !a.added).length;
				const dirty = this.stagedApiBase !== void 0 || this.stagedApiKeyEnv !== void 0 || this.stagedActiveAccount !== void 0 || this.stagedConcurrency !== void 0 || this.stagedQuotaRotation !== void 0 || this.defaultKeyDraft !== "" || this.defaultClearStaged || this.addedAccounts.length > 0 || this.removedIds.size > 0 || this.labelDrafts.size > 0 || this.keyDrafts.size > 0 || this.keyClears.size > 0;
				return {
					available: snapshot.status === "ready",
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
					quotaRotation,
					quotaRotationDraft: this.stagedQuotaRotation ?? quotaRotation,
					dirty,
					saving: this.saving,
					failed: this.failed,
					savedCount: this.savedCount
				};
			}
			/**
			* 计算当前实际生效账户 id：
			* - 显式钉选（activeAccount 非空且指向已保存账户）→ 该 id；
			* - 自动模式 → 默认账户已配置取 'default'，否则第一个已配置账户行 id，均无则 ''。
			* UI 据此展示「活动/当前」标记（运行时 401 禁用后的顺延以实际可用账号为准）。
			*/
			effectiveActiveAccountId(activeAccount, defaultConfigured) {
				if (activeAccount !== "") {
					const pinned = this.effectiveAccounts().find((a) => a.id === activeAccount);
					if (pinned !== void 0 && pinned.configured) return pinned.id;
				}
				if (defaultConfigured) return "default";
				const firstConfigured = this.effectiveAccounts().find((a) => a.configured);
				return firstConfigured !== void 0 ? firstConfigured.id : "";
			}
			/**
			* 当前实际生效账户的可读标签：'default' → 「默认账户」，
			* 其余取账户行 labelDraft（空则回退「账户 N」），无生效则 ''。
			* 用于自动模式下下拉选项与总览条展示「当前: xxx」。
			*/
			effectiveActiveAccountLabel(id, accounts) {
				if (id === "") return "";
				if (id === "default") return "默认账户";
				const account = accounts.find((a) => a.id === id);
				if (account === void 0) return id;
				const label = account.labelDraft.trim();
				return label !== "" ? label : `账户 ${accounts.indexOf(account) + 1}`;
			}
			/** 合并 stored（减 staged 删除）与 staged 新增，得到展示用账户行。 */
			effectiveAccounts() {
				const stored = this.storedAccounts().filter((a) => !this.removedIds.has(a.id)).map((a) => ({
					...a,
					added: false
				}));
				const added = this.addedAccounts.map((a) => ({
					...a,
					added: true
				}));
				return [...stored, ...added].map((a) => {
					const view = this.credentialStates.get(a.apiKeyEnv);
					return {
						id: a.id,
						ref: a.apiKeyEnv,
						label: a.label,
						labelDraft: this.labelDrafts.get(a.id) ?? a.label,
						keyDraft: this.keyDrafts.get(a.id) ?? "",
						configured: view?.configured ?? false,
						writable: view?.writable ?? true,
						added: a.added,
						clearStaged: this.keyClears.has(a.id)
					};
				});
			}
			edit(field, text) {
				if (field === "apiBase") this.stagedApiBase = text;
				else if (field === "apiKeyEnv") this.stagedApiKeyEnv = text;
				else if (field === "activeAccount") this.stagedActiveAccount = text;
				else if (field === "concurrency") this.stagedConcurrency = text;
				this.failed = false;
				this.publish();
			}
			editDefaultKey(text) {
				this.defaultKeyDraft = text;
				this.defaultClearStaged = false;
				this.failed = false;
				this.publish();
			}
			toggleDefaultKeyClear() {
				this.defaultClearStaged = !this.defaultClearStaged;
				if (this.defaultClearStaged) this.defaultKeyDraft = "";
				this.failed = false;
				this.publish();
			}
			addAccount() {
				const usedRefs = /* @__PURE__ */ new Set([
					...this.credentialRef() !== void 0 ? [this.credentialRef()] : [],
					...this.storedAccounts().map((a) => a.apiKeyEnv),
					...this.addedAccounts.map((a) => a.apiKeyEnv)
				]);
				let n = 2;
				while (usedRefs.has(`${DEFAULT_API_KEY_ENV}_${n}`)) n += 1;
				const apiKeyEnv = `${DEFAULT_API_KEY_ENV}_${n}`;
				const usedIds = /* @__PURE__ */ new Set([...this.storedAccounts().map((a) => a.id), ...this.addedAccounts.map((a) => a.id)]);
				let k = this.storedAccounts().length + this.addedAccounts.length + 2;
				let id = `account-${k}`;
				while (usedIds.has(id)) {
					k += 1;
					id = `account-${k}`;
				}
				this.addedAccounts.push({
					id,
					label: `账户 ${k}`,
					apiKeyEnv
				});
				this.failed = false;
				this.describeAll();
				this.publish();
			}
			removeAccount(id) {
				const addedIndex = this.addedAccounts.findIndex((a) => a.id === id);
				if (addedIndex >= 0) this.addedAccounts.splice(addedIndex, 1);
				else this.removedIds.add(id);
				this.labelDrafts.delete(id);
				this.keyDrafts.delete(id);
				this.keyClears.delete(id);
				const currentActive = this.sectionValue("activeAccount");
				if (this.stagedActiveAccount === id || this.stagedActiveAccount === void 0 && currentActive === id) this.stagedActiveAccount = "";
				this.failed = false;
				this.publish();
			}
			editAccountLabel(id, text) {
				this.labelDrafts.set(id, text);
				this.failed = false;
				this.publish();
			}
			editAccountKey(id, text) {
				this.keyDrafts.set(id, text);
				this.keyClears.delete(id);
				this.failed = false;
				this.publish();
			}
			toggleAccountKeyClear(id) {
				if (this.keyClears.has(id)) this.keyClears.delete(id);
				else {
					this.keyDrafts.delete(id);
					this.keyClears.add(id);
				}
				this.failed = false;
				this.publish();
			}
			/** activeAccount 单选：'' 表示自动（默认账户优先）。 */
			setActiveAccount(id) {
				this.stagedActiveAccount = id;
				this.failed = false;
				this.publish();
			}
			/** 配额类 429 换 key 开关（staged，保存后经 settings 命名空间持久化并热生效）。 */
			setQuotaRotation(on) {
				this.stagedQuotaRotation = on;
				this.failed = false;
				this.publish();
			}
			/** 丢弃所有 staged 编辑。 */
			discard() {
				this.stagedApiBase = void 0;
				this.stagedApiKeyEnv = void 0;
				this.stagedActiveAccount = void 0;
				this.stagedConcurrency = void 0;
				this.stagedQuotaRotation = void 0;
				this.defaultKeyDraft = "";
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
			async refreshCredentials() {
				await this.describeAll();
			}
			/** 当前页面涉及的 credential-ref 集合键（默认 ref + stored/added 账户 ref）。 */
			currentRefsKey() {
				const ref = this.credentialRef();
				return [.../* @__PURE__ */ new Set([
					...ref !== void 0 ? [ref] : [],
					...this.storedAccounts().map((a) => a.apiKeyEnv),
					...this.addedAccounts.map((a) => a.apiKeyEnv)
				])].sort().join(",");
			}
			/** refs 集合与上次成功查询不同则重查；查询失败保留旧键，下次快照变更自然重试。 */
			describeIfRefsChanged() {
				if (this.currentRefsKey() === this.describedRefsKey) return;
				this.describeAll();
			}
			/** 查询所有本页涉及的凭据引用的配置状态。 */
			async describeAll() {
				const refs = [
					...this.credentialRef() !== void 0 ? [this.credentialRef()] : [],
					...this.storedAccounts().map((a) => a.apiKeyEnv),
					...this.addedAccounts.map((a) => a.apiKeyEnv)
				];
				if (refs.length === 0) {
					this.describedRefsKey = "";
					return;
				}
				let response;
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
					const next = {
						configured: view?.configured ?? false,
						writable: view?.writable ?? true
					};
					const prev = this.credentialStates.get(ref);
					if (prev === void 0 || prev.configured !== next.configured || prev.writable !== next.writable) {
						this.credentialStates.set(ref, next);
						changed = true;
					}
				}
				if (changed) this.publish();
			}
			/** 写入某个凭据引用，然后重读配置状态。 */
			async writeKeyTo(ref, value) {
				const canonicalRef = canonicalCredentialRef(ref);
				if (canonicalRef === void 0) return false;
				try {
					if (!(await this.credentials.set(canonicalRef, value)).ok) return false;
				} catch {
					return false;
				}
				await this.describeAll();
				return this.credentialStates.get(canonicalRef)?.configured ?? false;
			}
			async unsetKey(ref) {
				const canonicalRef = canonicalCredentialRef(ref);
				if (canonicalRef === void 0) return false;
				try {
					if (!(await this.credentials.unset(canonicalRef)).ok) return false;
				} catch {
					return false;
				}
				await this.describeAll();
				return this.credentialStates.get(canonicalRef)?.configured !== true;
			}
			/** 持久化 accounts 列表。 */
			async writeAccounts() {
				const base = [...this.storedAccounts().filter((a) => !this.removedIds.has(a.id)), ...this.addedAccounts];
				const seen = /* @__PURE__ */ new Set();
				const list = [];
				for (const a of base) {
					if (seen.has(a.id)) continue;
					seen.add(a.id);
					const label = this.labelDrafts.get(a.id)?.trim();
					list.push({
						id: a.id,
						label: label !== void 0 && label !== "" ? label : a.label,
						apiKeyEnv: a.apiKeyEnv
					});
				}
				await this.scope.set("accounts", list);
				return true;
			}
			/** 保存所有 staged 编辑。 */
			async save() {
				if (this.saving) return;
				if (!this.state().dirty) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				try {
					const defaultRef = this.credentialRef();
					if (this.defaultClearStaged) {
						if (defaultRef === void 0 || !await this.unsetKey(defaultRef)) landed = false;
					} else if (this.defaultKeyDraft.trim() !== "") {
						if (defaultRef === void 0 || !await this.writeKeyTo(defaultRef, this.defaultKeyDraft.trim())) landed = false;
					}
					for (const id of this.keyClears) {
						const account = this.effectiveAccounts().find((a) => a.id === id);
						if (account !== void 0 && !await this.unsetKey(account.ref)) landed = false;
					}
					for (const [id, text] of this.keyDrafts) {
						const value = text.trim();
						if (value === "" || this.keyClears.has(id)) continue;
						const account = this.effectiveAccounts().find((a) => a.id === id);
						if (account !== void 0 && !await this.writeKeyTo(account.ref, value)) landed = false;
					}
					if (this.stagedApiBase !== void 0) {
						const value = this.stagedApiBase.trim();
						if (value === "") await this.scope.unset("apiBase");
						else await this.scope.set("apiBase", value);
					}
					if (this.stagedApiKeyEnv !== void 0) {
						const canonicalRef = canonicalCredentialRef(this.stagedApiKeyEnv);
						if (this.stagedApiKeyEnv.trim() === "") await this.scope.unset("apiKeyEnv");
						else if (canonicalRef === void 0) landed = false;
						else await this.scope.set("apiKeyEnv", canonicalRef);
					}
					if (this.stagedActiveAccount !== void 0) {
						if (this.stagedActiveAccount === "") await this.scope.unset("activeAccount");
						else await this.scope.set("activeAccount", this.stagedActiveAccount);
					}
					if (this.stagedConcurrency !== void 0) {
						const value = normalizeConcurrency(this.stagedConcurrency);
						await this.scope.set("concurrency", value);
					}
					if (this.stagedQuotaRotation !== void 0) await this.scope.set("quotaRotation", this.stagedQuotaRotation);
					if (this.addedAccounts.length > 0 || this.removedIds.size > 0 || this.labelDrafts.size > 0) await this.writeAccounts();
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
			publish() {
				if (this.disposed) return;
				for (const listener of [...this.listeners]) try {
					listener();
				} catch (error) {
					console.error("[dsh-sensenova-provider] state subscriber failed:", error);
				}
			}
		};
		//#endregion
		//#region src/client/section.tsx
		/**
		* SenseNova 设置页 React 组件（settings.section slot 内容）。
		* 所有文案经 `t`（settings.sensenova 命名空间）读取，不硬编码。
		*/
		const { useEffect, useRef } = react;
		function useSavedFlash(savedCount) {
			const [visible, setVisible] = (0, react.useState)(false);
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
		function StatusBadge({ configured, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: configured ? "sn-badge" : "sn-badgeMuted",
				children: configured ? t("apiKeySet") : t("apiKeyUnset")
			});
		}
		function addCredentialReference(refs, value) {
			const normalized = value.trim();
			if (normalized !== "") refs.add(normalized);
		}
		function credentialReferences(state) {
			const refs = /* @__PURE__ */ new Set();
			addCredentialReference(refs, state.apiKeyEnv);
			for (const account of state.accounts) addCredentialReference(refs, account.ref);
			return refs;
		}
		function isCredentialReference(label, refs) {
			const value = label.trim();
			if (value === "") return false;
			for (const ref of refs) if (value.includes(ref)) return true;
			return false;
		}
		function accountDisplayLabel(account, index, t, refs) {
			const label = account.labelDraft.trim();
			return label !== "" && !isCredentialReference(label, refs) ? label : t("accountFallback", { index: index + 1 });
		}
		/** 分组标题：引导后续卡片的分区归属。 */
		function SectionHeading(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
				className: "sn-groupTitle",
				children: props.text
			});
		}
		function AdvancedSettings(props) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const customizedCount = (props.state.apiBase !== "https://token.sensenova.cn/v1" ? 1 : 0) + (props.state.concurrency !== 1 ? 1 : 0) + (props.state.quotaRotation !== false ? 1 : 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-card sn-advanced",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "sn-advancedHeader",
					"aria-expanded": expanded,
					"aria-controls": "sn-advanced-settings",
					onClick: () => setExpanded((value) => !value),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "sn-label",
						children: props.t("advancedSettings")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "sn-advancedMeta",
						children: [customizedCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "sn-badgeMuted",
							"aria-label": props.t("advancedCustomizedCount", { count: customizedCount }),
							children: customizedCount
						}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: `sn-advancedChevron${expanded ? " sn-advancedChevronExpanded" : ""}`,
							"aria-hidden": "true"
						})]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					id: "sn-advanced-settings",
					className: "sn-advancedBody",
					hidden: !expanded,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "sn-label",
									htmlFor: "sn-api-base",
									children: props.t("apiBase")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: "sn-api-base",
									className: "sn-input",
									type: "text",
									value: props.state.apiBaseDraft,
									disabled: props.disabled,
									spellCheck: false,
									onChange: (event) => props.edit("apiBase", event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "sn-hint",
									children: props.t("apiBaseHint")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-models",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-concurrency",
										children: props.t("concurrency")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-concurrency",
										className: "sn-input",
										type: "number",
										min: 1,
										step: 1,
										value: props.state.concurrencyDraft,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.edit("concurrency", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("concurrencyHint")
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint sn-modelsNote",
								children: props.t("modelsAutoManaged")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "sn-fieldHead",
								htmlFor: "sn-quota-rotation",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-label",
									children: props.t("quotaRotation")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: "sn-quota-rotation",
									className: "sn-toggle",
									type: "checkbox",
									checked: props.state.quotaRotationDraft,
									disabled: props.disabled,
									onChange: (event) => props.setQuotaRotation(event.target.checked)
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint",
								children: props.t("quotaRotationHint")
							})]
						})
					]
				})]
			});
		}
		function SenseNovaSection(props) {
			const { t } = props;
			const state = props.useSensenovaSettings((s) => s);
			const disabled = !state.writable;
			const savedVisible = useSavedFlash(state.savedCount);
			const accounts = state.accounts;
			const credentialRefs = credentialReferences(state);
			const savedAccounts = accounts.filter((account) => !account.added);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "sn-section",
				"aria-label": t("title"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "sn-title",
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-intro",
						children: t("intro")
					}),
					!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-readOnly",
						role: "status",
						children: t("readOnly")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionHeading, { text: t("groupConnection") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "sn-card sn-cardCompact",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-fieldHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-label",
									children: t("routeLabel")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-badges",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-badge",
										children: state.route
									})
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint",
								children: state.displayName
							})]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionHeading, { text: t("groupCredentials") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "sn-field",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-fieldHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-label",
									children: t("defaultAccount")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "sn-badges",
									children: [state.effectiveActiveAccountId === "default" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-badge sn-badgeActive",
										children: t("activeBadgeEffectiveFull")
									}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
										configured: state.defaultConfigured,
										t
									})]
								})]
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DefaultKeyField, {
							t,
							draft: state.defaultKeyDraft,
							disabled: disabled || !state.defaultWritable,
							configured: state.defaultConfigured,
							clearStaged: state.defaultClearStaged,
							onEdit: props.editDefaultKey,
							onToggleClear: props.toggleDefaultKeyClear
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sn-fieldHead",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-label",
										children: t("accountsTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "sn-btnAdd",
										disabled,
										onClick: props.addAccount,
										children: t("accountAdd")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "sn-hint",
									children: state.quotaRotationDraft ? t("accountsHintQuotaRotation") : t("accountsHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-accountSummary",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-accountSummaryStats",
									children: t("accountSummary", {
										total: state.totalCount,
										configured: state.configuredCount
									})
								}), state.effectiveActiveAccountLabel !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "sn-accountSummaryActive",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-dotPulse",
										"aria-hidden": "true"
									}), t("accountSummaryActive", { label: state.effectiveActiveAccountLabel })]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-accountSummaryNone",
									children: t("accountSummaryNone")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "sn-label",
									htmlFor: "sn-active-account",
									children: t("activeAccount")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sn-activeAccountControl",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "sn-activeAccountSelect",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											id: "sn-active-account",
											className: "sn-input",
											value: state.activeAccountDraft,
											disabled,
											onChange: (event) => props.setActiveAccount(event.target.value),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: state.effectiveActiveAccountLabel !== "" ? `${t("activeAccountAuto")} → ${state.effectiveActiveAccountLabel}` : t("activeAccountAuto")
											}), savedAccounts.map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: account.id,
												children: accountDisplayLabel(account, index, t, credentialRefs)
											}, account.id))]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "sn-selectChevron",
											"aria-hidden": "true"
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "sn-reset",
										disabled,
										onClick: () => props.setActiveAccount(""),
										children: t("activeAccountReset")
									})]
								})]
							}),
							accounts.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "sn-accountList",
								children: accounts.map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
									t,
									account,
									refs: credentialRefs,
									index,
									disabled,
									isActive: state.effectiveActiveAccountId === account.id,
									isPinned: state.activeAccountDraft === account.id,
									onRemove: () => props.removeAccount(account.id),
									onLabel: (text) => props.editAccountLabel(account.id, text),
									onKey: (text) => props.editAccountKey(account.id, text),
									onToggleClear: () => props.toggleAccountKeyClear(account.id)
								}, account.id))
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionHeading, { text: t("groupAdvanced") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AdvancedSettings, {
						t,
						state,
						disabled,
						edit: props.edit,
						setQuotaRotation: props.setQuotaRotation
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-footer",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "sn-footerStatus",
							children: state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-failed",
								role: "status",
								children: t("saveFailed")
							}) : savedVisible && !state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-saved",
								role: "status",
								children: t("saved")
							}) : state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "sn-unsaved",
								children: t("unsaved")
							}) : null
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-footerActions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-btnGhost",
								disabled: !state.dirty || state.saving,
								onClick: props.discard,
								children: t("reset")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-btnPrimary",
								disabled: !state.dirty || state.saving,
								onClick: props.save,
								children: state.saving ? t("saving") : t("save")
							})]
						})]
					})
				]
			});
		}
		function DefaultKeyField(props) {
			const { t } = props;
			const [visible, setVisible] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "sn-label",
							htmlFor: "sn-default-key",
							children: t("defaultKey")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "sn-badges",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-reset",
								disabled: props.disabled,
								onClick: () => setVisible((v) => !v),
								children: visible ? t("hide") : t("show")
							}), props.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-reset",
								disabled: props.disabled,
								onClick: props.onToggleClear,
								children: t("clearKey")
							}) : null]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "sn-default-key",
						className: "sn-input",
						type: visible ? "text" : "password",
						autoComplete: "off",
						spellCheck: false,
						value: props.draft,
						disabled: props.disabled,
						onChange: (event) => props.onEdit(event.target.value)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: t("defaultKeyHint")
					})
				]
			});
		}
		function AccountRow(props) {
			const { t, account } = props;
			const [visible, setVisible] = (0, react.useState)(false);
			const displayLabel = accountDisplayLabel(account, props.index, t, props.refs);
			const labelDraft = isCredentialReference(account.labelDraft, props.refs) ? "" : account.labelDraft;
			const labelId = `sn-account-label-${account.id}`;
			const keyId = `sn-account-key-${account.id}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-accountRow",
				"data-sn-active": props.isActive ? "true" : void 0,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "sn-accountHead",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "sn-label",
						title: displayLabel,
						children: displayLabel
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "sn-accountActions",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "sn-badges",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
									configured: account.configured,
									t
								}), props.isActive ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-badge sn-badgeActive",
									children: props.isPinned ? t("activeBadge") : t("activeBadgeEffectiveFull")
								}) : null]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-iconBtn",
								disabled: props.disabled || !account.writable,
								title: visible ? t("hide") : t("show"),
								"aria-label": visible ? t("hide") : t("show"),
								onClick: () => setVisible((v) => !v),
								children: visible ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconEyeOff, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconEye, {})
							}),
							account.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-iconBtn",
								disabled: props.disabled || !account.writable,
								title: t("clearKey"),
								"aria-label": t("clearKey"),
								onClick: props.onToggleClear,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconEraser, {})
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-iconBtn sn-iconBtnDanger",
								disabled: props.disabled,
								title: t("accountRemove"),
								"aria-label": t("accountRemove"),
								onClick: props.onRemove,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTrash, {})
							})
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "sn-accountFields",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-accountField",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "sn-labelSmall",
							htmlFor: labelId,
							children: t("accountLabel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: labelId,
							className: "sn-input",
							type: "text",
							placeholder: t("accountLabel"),
							value: labelDraft,
							disabled: props.disabled,
							spellCheck: false,
							onChange: (event) => props.onLabel(event.target.value)
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-accountField",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "sn-labelSmall",
								htmlFor: keyId,
								children: t("accountKey")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: keyId,
								className: "sn-input",
								type: visible ? "text" : "password",
								autoComplete: "off",
								placeholder: t("accountKey"),
								spellCheck: false,
								value: account.keyDraft,
								disabled: props.disabled || !account.writable,
								onChange: (event) => props.onKey(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint",
								children: t("accountKeyHint")
							})
						]
					})]
				})]
			});
		}
		/** 行内 SVG 图标（currentColor，随主题变色）。 */
		function IconEye() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M1.5 8s2.2-3.6 6.5-3.6S14.5 8 14.5 8 12.3 11.6 8 11.6 1.5 8 1.5 8Z",
					stroke: "currentColor",
					strokeWidth: "1.3"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "8",
					r: "1.8",
					stroke: "currentColor",
					strokeWidth: "1.3"
				})]
			});
		}
		function IconEyeOff() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M1.5 8s2.2-3.6 6.5-3.6c1.5 0 2.8.5 3.8 1.2M14.5 8s-.8 1.3-2.4 2.5M6.6 11.3c.5.1.9.2 1.4.2",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M3 13 13 3",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				})]
			});
		}
		function IconEraser() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M9.5 3.5 13.5 7.5 8 13H4.5L2.5 11c-.6-.6-.6-1.5 0-2.1l4.4-4.4c.6-.6 1.5-.6 2.1 0l.5.5Z",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinejoin: "round"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M6 13h8",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				})]
			});
		}
		function IconTrash() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				fill: "none",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M2.5 4h11M6.5 2.5h3M5 4l.5 8.5c0 .6.4 1 1 1h3c.6 0 1-.4 1-1L11 4",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});
		}
		//#endregion
		//#region src/client/card.tsx
		function SenseNovaProviderCard(props) {
			const { t } = props;
			const state = props.useSensenovaSettings !== void 0 ? props.useSensenovaSettings((snapshot) => snapshot) : void 0;
			const configuredAccounts = state?.accounts.filter((a) => a.configured).length ?? 0;
			const configured = state !== void 0 && state.available ? state.defaultConfigured || configuredAccounts > 0 : props.keyConfigured ?? false;
			const active = props.provider?.active ?? false;
			const showBody = state !== void 0 && state.available;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-providerCard",
				"data-sn-models-card": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "sn-field",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "sn-label",
							children: t("cardTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "sn-badges",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: configured ? "sn-badge" : "sn-badgeMuted",
								children: configured ? t("apiKeySet") : t("apiKeyUnset")
							}), active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "sn-badge",
								children: t("cardRouteActive")
							}) : null]
						})]
					}), !showBody ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: state === void 0 ? t("cardRegistrationHint") : t("cardLoadingHint")
					}) : configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: t("cardConfiguredHint")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: t("cardUnconfiguredHint")
					})]
				}), showBody ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: "sn-hint",
					children: [
						t("cardAccounts"),
						": ",
						state.accounts.length,
						state.activeAccount !== "" ? ` · ${t("cardActiveAccount")}: ${state.activeAccount}` : ""
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* SenseNova 设置页与 Models 页卡片的文案（zh/en 双语）。
		* 注册命名空间：`settings.sensenova`（与 settings.section / provider-card 的
		* locale 选项一致，参考 @mars-sea/dsh-commandcode-provider 的 `settings.commandcode`）。
		*/
		const zh = {
			nav: "SenseNova",
			title: "SenseNova",
			intro: "配置 SenseNova Provider 连接。API 密钥仅写入本机凭据服务、不会回显；其余字段写入用户设置，保存后立即生效。",
			routeLabel: "Provider 路由",
			apiBase: "API 地址",
			apiBaseHint: "默认 https://token.sensenova.cn/v1，一般无需修改。",
			defaultKey: "默认账户 API 密钥",
			defaultKeyHint: "在 SenseNova 控制台创建。留空保存不会覆盖已存储的密钥。",
			apiKeySet: "已配置",
			apiKeyUnset: "未配置",
			defaultAccount: "默认账户",
			accountsTitle: "多账户轮换",
			accountsHint: "仅在密钥失效（401）时自动切换到下一个可用账户；429 限流不切换账户，由宿主重试层退避后使用原 key 重试。",
			accountsHintQuotaRotation: "密钥失效（401）时自动切换账户；已开启「配额类 429 换 key」，配额类 429 限流时也会切换到下一把 key 并粘住；任何 429 都不会冷却或禁用账户，由宿主退避后重试。",
			accountAdd: "添加账户",
			accountRemove: "删除",
			accountLabel: "账户备注名",
			accountKey: "API 密钥",
			accountKeyHint: "该账户的 API 密钥。留空保存不会覆盖已存储的密钥。",
			accountFallback: "账户 {index}",
			activeAccount: "活动账户",
			activeAccountReset: "重置为自动",
			activeAccountAuto: "自动（第一个可用账户）",
			activeBadge: "活动",
			activeBadgeEffective: "当前",
			activeBadgeEffectiveFull: "当前生效",
			accountSummary: "共 {total} 个账户 · {configured} 个已配置",
			accountSummaryActive: "当前生效：{label}",
			accountSummaryNone: "尚无已配置账户",
			advancedSettings: "高级设置",
			advancedCustomizedCount: "已自定义 {count} 项",
			concurrency: "并发上限",
			concurrencyHint: "同一 API key 同时进行的生成请求数（默认 1）。超出上限的请求排队等待，避免触发渠道并发限流。",
			quotaRotation: "配额类 429 换 key",
			quotaRotationHint: "仅限流耗尽时切换到下一把 key 并粘住；密钥失效（401）行为不变。",
			added: "未保存",
			readOnly: "当前配置为只读。",
			show: "显示",
			hide: "隐藏",
			clearKey: "清除已存密钥",
			reset: "重置",
			save: "保存",
			saving: "保存中…",
			saved: "已保存 ✓",
			saveFailed: "保存失败，请重试。",
			unsaved: "未保存",
			cardTitle: "SenseNova 连接",
			cardRouteActive: "已启用",
			cardLoadingHint: "正在读取 SenseNova 配置…",
			cardRegistrationHint: "此卡片随 SenseNova 插件注册，需要较新版本的 DeepSeek Harness 才会显示完整内容。",
			cardConfiguredHint: "API 密钥已就绪。如需更换密钥、添加多账户或修改 API 地址，请前往「设置 → SenseNova」。",
			cardUnconfiguredHint: "尚未配置 API 密钥，请前往「设置 → SenseNova」完成配置。",
			cardAccounts: "已配置账户",
			cardActiveAccount: "活动账户",
			modelInclude: "手动加入模型",
			modelIncludeHint: "仅接受最新目录中的文本模型；可用换行或逗号分隔。可重新加入 stale 文本模型，但 image-only 模型始终排除。",
			modelExclude: "隐藏模型",
			modelExcludeHint: "可用换行或逗号分隔；与手动加入冲突时隐藏优先。",
			groupConnection: "接入信息",
			groupCredentials: "凭据与账户",
			groupAdvanced: "高级选项"
		};
		const en = {
			nav: "SenseNova",
			title: "SenseNova",
			intro: "Configure the SenseNova provider connection. The API key is written only to the local credential service and never echoed; other fields are written to user settings and take effect immediately after saving.",
			routeLabel: "Provider route",
			apiBase: "API base URL",
			apiBaseHint: "Defaults to https://token.sensenova.cn/v1; usually leave as-is.",
			defaultKey: "Default account API key",
			defaultKeyHint: "Create one in the SenseNova console. Saving with this field blank keeps the stored key.",
			apiKeySet: "Configured",
			apiKeyUnset: "Not configured",
			defaultAccount: "Default account",
			accountsTitle: "Account rotation",
			accountsHint: "Requests switch to the next usable account only when a key fails (401); 429 rate limits do not switch accounts, and the host retry layer backs off before retrying with the original key.",
			accountsHintQuotaRotation: "Requests switch accounts when a key fails (401); with “Rotate key on quota 429” enabled, quota-type 429 rate limits also switch to the next key and stick with it. Accounts are never disabled by 429s; the host retry layer backs off before retrying.",
			accountAdd: "Add account",
			accountRemove: "Remove",
			accountLabel: "Account label",
			accountKey: "API key",
			accountKeyHint: "This account’s API key. Saving with the field blank keeps the stored key.",
			accountFallback: "Account {index}",
			activeAccount: "Active account",
			activeAccountReset: "Reset to auto",
			activeAccountAuto: "Auto (first usable account)",
			activeBadge: "Active",
			activeBadgeEffective: "Current",
			activeBadgeEffectiveFull: "Active",
			accountSummary: "{total} accounts · {configured} configured",
			accountSummaryActive: "Active: {label}",
			accountSummaryNone: "No configured account",
			advancedSettings: "Advanced settings",
			advancedCustomizedCount: "{count} customized",
			concurrency: "Concurrency limit",
			concurrencyHint: "Maximum concurrent generation requests per API key (default 1). Requests beyond the limit queue instead of failing, avoiding channel rate limits.",
			quotaRotation: "Rotate key on quota 429",
			quotaRotationHint: "Switch to the next key only when rate limits are exhausted, then stick with it; key invalidation (401) behavior is unchanged.",
			added: "Unsaved",
			readOnly: "Settings are read-only.",
			show: "Show",
			hide: "Hide",
			clearKey: "Clear stored key",
			reset: "Reset",
			save: "Save",
			saving: "Saving…",
			saved: "Saved ✓",
			saveFailed: "Save failed, please retry.",
			unsaved: "Unsaved",
			cardTitle: "SenseNova connection",
			cardRouteActive: "Active",
			cardLoadingHint: "Loading the SenseNova configuration…",
			cardRegistrationHint: "This card is contributed by the SenseNova plugin; a newer DeepSeek Harness is needed to show the full controls.",
			cardConfiguredHint: "The API key is ready. To replace it, add account rotation, or change the API base, open “Settings → SenseNova”.",
			cardUnconfiguredHint: "No API key configured yet; open “Settings → SenseNova” to finish setup.",
			cardAccounts: "Configured accounts",
			cardActiveAccount: "Active account",
			modelInclude: "Manually include models",
			modelIncludeHint: "Only models in the latest catalog are accepted; separate IDs with newlines or commas. Stale text models may be restored, but image-only models are always excluded.",
			modelExclude: "Hide models",
			modelExcludeHint: "Separate IDs with newlines or commas; exclusions take priority over includes.",
			groupConnection: "Connection",
			groupCredentials: "Credentials & accounts",
			groupAdvanced: "Advanced"
		};
		//#endregion
		//#region src/client/index.ts
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
		/** 把旧版 ApiProxy 凭据面适配为 CredentialsFace。 */
		function adaptLegacyCredentials(legacy) {
			if (legacy === void 0) return void 0;
			return {
				describe: async (refs) => {
					const response = await legacy.describe({ refs });
					if (!response.result.ok) return { ok: false };
					const value = response.result.value?.credentials;
					return value === void 0 ? { ok: true } : {
						ok: true,
						value
					};
				},
				set: async (ref, value) => {
					const response = await legacy.set({
						ref,
						value
					});
					return response.result.ok ? { ok: true } : {
						ok: false,
						error: response.result.error
					};
				},
				unset: async (ref) => {
					const response = await legacy.unset({ ref });
					return response.result.ok ? { ok: true } : {
						ok: false,
						error: response.result.error
					};
				}
			};
		}
		function injectPageCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-sensenova-provider-css")) return;
			const tag = document.createElement("style");
			tag.id = "dsh-sensenova-provider-css";
			tag.textContent = [
				".sn-section{display:flex;flex-direction:column;gap:14px}",
				".sn-title{font-size:16px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,#222)}",
				".sn-intro,.sn-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin:2px 0 0;line-height:1.5}",
				".sn-readOnly,.sn-failed{font-size:12px;color:var(--dsw-alias-label-error,#d9534f);margin:0}",
				".sn-saved{font-size:12px;color:var(--dsw-alias-label-success,#2e8b57);margin:0}",
				".sn-unsaved{font-size:12px;color:var(--dsw-alias-label-warning,#b58900);margin:0}",
				".sn-groupTitle{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin:10px 0 -4px;padding:0 2px}",
				".sn-groupTitle:first-of-type{margin-top:2px}",
				".sn-card{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}",
				".sn-cardCompact{padding:10px 14px}",
				".sn-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
				".sn-fieldHead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}",
				".sn-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#222);min-width:0}",
				".sn-labelSmall{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#5c5c5c)}",
				".sn-badges{display:inline-flex;gap:6px;align-items:center;flex:0 0 auto;min-width:0;white-space:nowrap}",
				".sn-badge,.sn-badgeMuted,.sn-badgeActive{font-size:11px;padding:1px 8px;border-radius:999px;white-space:nowrap;line-height:17px}",
				".sn-badge{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,#5c5c5c);font-weight:500}",
				".sn-badgeMuted{background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
				".sn-badgeActive{background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}",
				".sn-input{box-sizing:border-box;width:100%;font-size:13px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#222);min-width:0}",
				".sn-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}",
				"select.sn-input{appearance:none;cursor:pointer;padding-right:30px}",
				".sn-activeAccountSelect{position:relative;flex:1 1 auto;min-width:0}",
				".sn-activeAccountSelect>.sn-input{width:100%}",
				".sn-selectChevron{position:absolute;right:8px;top:50%;width:14px;height:14px;transform:translateY(-50%);background-color:var(--dsw-alias-label-tertiary,#888f98);pointer-events:none;-webkit-mask:url(\"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 14 14%27 fill=%27none%27%3E%3Cpath d=%27M3 5.5 7 9l4-3.5%27 stroke=%27white%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E\") center / 14px 14px no-repeat;mask:url(\"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 14 14%27 fill=%27none%27%3E%3Cpath d=%27M3 5.5 7 9l4-3.5%27 stroke=%27white%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E\") center / 14px 14px no-repeat}",
				".sn-textarea{display:block;line-height:1.45;min-height:88px;resize:vertical}",
				".sn-accountList{display:flex;flex-direction:column;gap:0;min-width:0}",
				".sn-accountRow{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 0}",
				".sn-accountRow:first-child{padding-top:2px}",
				".sn-accountRow+.sn-accountRow{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}",
				".sn-accountHead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:nowrap}",
				".sn-accountHead>.sn-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".sn-accountActions{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-width:0;white-space:nowrap}",
				".sn-accountActions>.sn-badges{margin-right:4px}",
				".sn-accountFields{display:flex;flex-wrap:wrap;gap:8px 12px;min-width:0}",
				".sn-accountField{display:flex;flex-direction:column;gap:4px;flex:1 1 200px;min-width:0}",
				".sn-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer}",
				".sn-iconBtn:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#3b82f6);background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.1))}",
				".sn-iconBtn:disabled{opacity:.5;cursor:not-allowed}",
				".sn-iconBtnDanger:hover:not(:disabled){color:var(--dsw-alias-label-error,#d9534f)}",
				".sn-activeAccountControl{display:flex;align-items:center;gap:8px;min-width:0}",
				".sn-reset{font-size:12px;line-height:1.4;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);cursor:pointer;white-space:nowrap}",
				".sn-reset:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#3b82f6)}",
				".sn-reset:disabled{opacity:.5;cursor:not-allowed}",
				".sn-btnAdd{font-size:12px;line-height:1.4;padding:3px 10px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);cursor:pointer;white-space:nowrap}",
				".sn-btnAdd:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6)}",
				".sn-btnAdd:disabled{opacity:.5;cursor:not-allowed}",
				".sn-btnPrimary{font-size:13px;line-height:1.4;padding:6px 14px;border-radius:6px;border:1px solid transparent;background:var(--dsw-alias-button-primary-fill,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);cursor:pointer}",
				".sn-btnPrimary:hover:not(:disabled){filter:brightness(.94)}",
				".sn-btnPrimary:disabled{opacity:.5;cursor:not-allowed}",
				".sn-btnGhost{font-size:13px;line-height:1.4;padding:6px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);cursor:pointer}",
				".sn-btnGhost:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6)}",
				".sn-btnGhost:disabled{opacity:.5;cursor:not-allowed}",
				".sn-footer{display:flex;flex-direction:column;align-items:stretch;gap:8px;margin-top:2px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}",
				".sn-footerStatus{display:flex;flex-direction:column;gap:2px;min-height:16px}",
				".sn-footerActions{display:flex;align-items:center;justify-content:flex-end;gap:8px}",
				".sn-advanced{gap:0;padding:0;overflow:hidden}",
				".sn-advancedHeader{display:flex;align-items:center;width:100%;gap:8px;padding:12px 14px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;text-align:left;cursor:pointer}",
				".sn-advancedHeader:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08))}",
				".sn-advancedHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-2px}",
				".sn-advancedMeta{display:inline-flex;align-items:center;gap:8px;margin-left:auto;white-space:nowrap}",
				".sn-advancedChevron{width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-tertiary,#888f98);border-bottom:1.5px solid var(--dsw-alias-label-tertiary,#888f98);transform:rotate(45deg);transition:transform .15s ease}",
				".sn-advancedChevronExpanded{transform:rotate(225deg)}",
				".sn-advancedBody{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));min-width:0}",
				".sn-advancedBody[hidden]{display:none}",
				".sn-models{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}",
				".sn-toggle{width:16px;height:16px;margin:0;flex:0 0 auto;accent-color:var(--dsw-alias-brand-primary,#3b82f6);cursor:pointer}",
				".sn-toggle:disabled{opacity:.5;cursor:not-allowed}",
				".sn-providerCard{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}",
				".sn-accountSummary{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}",
				".sn-accountSummaryStats{font-size:12px;color:var(--dsw-alias-label-secondary,#5c5c5c);font-weight:500}",
				".sn-accountSummaryActive{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary,#222);font-weight:600}",
				".sn-accountSummaryNone{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
				".sn-dotPulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#3b82f6);animation:sn-pulse 1.8s ease-in-out infinite}",
				"@keyframes sn-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}",
				".sn-accountRow[data-sn-active=\"true\"]{border-left:3px solid var(--dsw-alias-brand-primary,#3b82f6);padding-left:10px;margin-left:-3px;background:var(--dsw-alias-bg-layer-2,rgba(59,130,246,.06));border-radius:4px}"
			].join("\n");
			document.head.appendChild(tag);
		}
		/** 在给定的 ctx 上挂载两个槽，共享同一个设置控制器与快照 store。 */
		function applyClientSurfaces(ctx, credentials) {
			const controller = new SenseNovaSettingsController(ctx.settingsScope.bind({ namespace: SENSENOVA_NS }), credentials);
			ctx.effect(() => () => controller.dispose(), "dsh-sensenova-provider: settings controller");
			const store = createSnapshotStore(controller.state());
			controller.subscribe(() => store.set(controller.state()));
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", () => {
				controller.refreshCredentials();
			}), "dsh-sensenova-provider: credential invalidations");
			const injected = () => ({
				hooks: { sensenovaSettings: store },
				edit: (field, text) => controller.edit(field, text),
				save: () => void controller.save(),
				discard: () => controller.discard(),
				addAccount: () => controller.addAccount(),
				removeAccount: (id) => controller.removeAccount(id),
				editAccountLabel: (id, text) => controller.editAccountLabel(id, text),
				editAccountKey: (id, text) => controller.editAccountKey(id, text),
				toggleAccountKeyClear: (id) => controller.toggleAccountKeyClear(id),
				editDefaultKey: (text) => controller.editDefaultKey(text),
				toggleDefaultKeyClear: () => controller.toggleDefaultKeyClear(),
				setActiveAccount: (id) => controller.setActiveAccount(id),
				setQuotaRotation: (on) => controller.setQuotaRotation(on)
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "sensenova",
				order: 13,
				label: () => ctx.locale.bind("settings.sensenova")("nav"),
				locale: "settings.sensenova",
				inject: injected
			}, SenseNovaSection));
			ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
				name: "settings.models.provider-card",
				key: "llm-sensenova",
				locale: "settings.sensenova",
				inject: () => ({
					hooks: { sensenovaSettings: store },
					edit: (field, text) => controller.edit(field, text),
					save: () => void controller.save()
				})
			}, SenseNovaProviderCard));
		}
		const inject = [
			"slots",
			"locale",
			"connection",
			"remote",
			"settingsScope"
		];
		function apply(ctx) {
			injectPageCss();
			ctx.effect(() => ctx.locale.register("settings.sensenova", {
				zh,
				en
			}), "dsh-sensenova-provider: page copy");
			const legacy = adaptLegacyCredentials(ctx.connection?.api?.credentials);
			if (legacy !== void 0) {
				applyClientSurfaces(ctx, legacy);
				return;
			}
			ctx.inject(["remote.credentials"], (remoteCtx) => {
				applyClientSurfaces(remoteCtx, remoteCtx.remote.credentials);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map