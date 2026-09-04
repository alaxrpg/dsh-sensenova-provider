import z from "@deepseek-ai/schemastery";
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId, assertUsableApiKey, attributionHeaders, errorChain, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
//#region src/accounts.ts
/**
* SenseNova provider 的多账号池（host 侧，精简版）。
*
* 与参考插件 @mars-sea/dsh-commandcode-provider 的账号池相比，本实现只保留
* 「401 禁用轮换」这一项能力：429 不做冷却（渠道常态性 RPM 瞬时超限，由宿主
* 重试层退避后原 key 重试），没有 probeWindow、FiveHourWindowProbe、plan、
* login 等任何无关功能。
*
* 轮换状态以 API key 字符串为键（key 原文永不写日志、不发往任何第三方）。
* 同一个 key 被多个槽位引用时共享一条状态；key 在凭据服务中被改值后是
* 新键、状态自然清零。状态只存内存，不持久化，重启后全部恢复可用。
*
* 本模块刻意不依赖 cordis：宿主事实一律通过注入 thunk 进入，node 测试可
* 直接驱动。
*
* @module dsh-sensenova-provider/accounts
*/
/** 该状态此刻能否服务请求。undefined（从未被拒绝）或非 disabled 视为可用。 */
function accountUsable(state) {
	return state === void 0 || state.kind !== "disabled";
}
/** 选择此刻应服务的账户：优先 preferredId（可用时），否则首个可用；全部不可用返回 undefined。 */
function selectActiveAccount(accounts, preferredId) {
	const usable = accounts.filter((account) => accountUsable(account.state));
	if (preferredId !== void 0 && preferredId !== "") {
		const preferred = usable.find((account) => account.slot.id === preferredId);
		if (preferred !== void 0) return preferred;
	}
	return usable[0];
}
/**
* 解析 HTTP Retry-After（延迟秒数或 HTTP-date）为毫秒；缺失/不可解析返回 undefined。
* HTTP-date 早于 now 时返回 0（调用方自行丢弃）。
*/
function parseRetryAfterMs(value, now = Date.now()) {
	if (value === void 0 || value === null) return void 0;
	const trimmed = value.trim();
	if (trimmed === "") return void 0;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) {
		const ms = Math.round(seconds * 1e3);
		return Number.isFinite(ms) ? ms : void 0;
	}
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) return Math.max(0, date - now);
}
/**
* 记录一次拒绝。`invalid-credential`（401）永久禁用。
* `rate-limit` 与 `quota-exhausted`（429，含 quotaRotation 开启时的配额类粘性换 key）
* 不写任何状态：SenseNova 渠道常态性限流不代表账号异常，任何 429 都不冷却、
* 不禁用账号（design D1/D5，2026-09-04 实测）；配额类粘性换 key 只选取下一把
* 可用 key，被拒 key 保持可用。状态写入 `states`（以 key 为键），便于测试直接驱动。
*/
function markRejected(states, key, rejection, _retryAfterMs) {
	if (rejection === "invalid-credential") states.set(key, {
		kind: "disabled",
		until: 0
	});
}
/** SenseNova 多账号池：以 key 为键的轮换状态 + 解析/选择/拒绝。 */
var SensenovaAccountPool = class {
	deps;
	/** 以 API key 为键的轮换状态（key 原文不落日志）。 */
	states = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	/** 解析每个槽位的 key 并按 key 去重（首个槽位胜出）；无 key 的槽位被忽略。 */
	async resolvedAccounts() {
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		for (const slot of this.deps.slots()) {
			const key = await slot.resolveKey();
			if (key === void 0 || key === "") continue;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				slot,
				key,
				state: this.states.get(key)
			});
		}
		return out;
	}
	/**
	* 发放一个可用 key：优先 preferredId（可用时）否则首个可用。
	* 没有任何 key 解析出来 → 返回 undefined（调用方报 MISSING_CREDENTIAL）。
	* 全部不可用（全 disabled，仅 401 产生）→ INVALID_CREDENTIAL。
	* `options.exclude` 跳过某个 key（401 轮换时排除刚被拒绝的 key）。
	*/
	async resolveKey(options) {
		const all = await this.resolvedAccounts();
		if (all.length === 0) return void 0;
		const candidates = options?.exclude !== void 0 ? all.filter((account) => account.key !== options.exclude) : all;
		if (candidates.length === 0) return void 0;
		const chosen = selectActiveAccount(candidates, this.deps.preferredId?.());
		if (chosen !== void 0) return {
			key: chosen.key,
			slot: chosen.slot
		};
		throw new LlmError(`llm-sensenova: every configured SenseNova account (${all.length}) was rejected with 401 — check the stored API keys；已配置的 ${all.length} 个 SenseNova 账户密钥均被拒绝（401）——请在设置页检查存储的 API 密钥`, "INVALID_CREDENTIAL");
	}
	/** 记录一次拒绝（委托给模块级 markRejected，共享同一状态 Map）。 */
	markRejected(key, rejection, retryAfterMs) {
		markRejected(this.states, key, rejection, retryAfterMs);
	}
};
//#endregion
//#region src/concurrency.ts
/** 排队超时默认值（毫秒）。2026-09-04 实测：与 TPM 60s 窗口对齐（design D4/D6）。 */
const DEFAULT_QUEUE_TIMEOUT_MS = 6e4;
/** 把配置的并发上限归一化为正整数：非整数、负数或无法解析一律回退 1。 */
function normalizeConcurrencyLimit(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}
/** 排队/等待期间中止时抛出的取消错误（不占额度）。 */
function concurrencyAbortError() {
	return new DOMException("The operation was aborted.", "AbortError");
}
/** 排队超时抛出的超时错误（不占额度；adapter 层映射为可重试 LlmError 'TIMEOUT'）。 */
function concurrencyQueueTimeoutError() {
	return new DOMException("The operation was timed out.", "TimeoutError");
}
/**
* 按 key 隔离的并发闸：`acquire(key, limit, signal?, queueTimeoutMs?)` 在额度
* 允许时立即返回 `release()`；达到上限时按 FIFO 排队，前序释放后唤起队首。
* 排队期间 signal 中止则 reject 取消错误且不占额度；排队超过 `queueTimeoutMs`
* （非法值回退默认 60s）则以可重试 TimeoutError reject，同样不占额度、从队列
* 移除并清 abort listener。release 幂等，排空后惰性删除 key 条目。
*/
var KeyedConcurrencyGate = class {
	states = /* @__PURE__ */ new Map();
	acquire(key, limit, signal, queueTimeoutMs) {
		const capacity = normalizeConcurrencyLimit(limit);
		const timeoutMs = typeof queueTimeoutMs === "number" && Number.isFinite(queueTimeoutMs) && queueTimeoutMs > 0 ? queueTimeoutMs : DEFAULT_QUEUE_TIMEOUT_MS;
		if (signal?.aborted) return Promise.reject(concurrencyAbortError());
		let state = this.states.get(key);
		if (state === void 0) {
			state = {
				inFlight: 0,
				queue: []
			};
			this.states.set(key, state);
		}
		if (state.inFlight < capacity) {
			state.inFlight += 1;
			return Promise.resolve(this.releaseOf(key, state));
		}
		return new Promise((resolve, reject) => {
			let timer;
			const entry = {
				signal,
				resolve: () => {
					if (timer !== void 0) clearTimeout(timer);
					if (entry.signal !== void 0) entry.signal.removeEventListener("abort", entry.onAbort);
					state.inFlight += 1;
					resolve(this.releaseOf(key, state));
				},
				reject: (error) => {
					if (timer !== void 0) clearTimeout(timer);
					if (entry.signal !== void 0) entry.signal.removeEventListener("abort", entry.onAbort);
					reject(error);
				},
				onAbort: () => {
					if (timer !== void 0) clearTimeout(timer);
					const index = state.queue.indexOf(entry);
					if (index >= 0) state.queue.splice(index, 1);
					reject(concurrencyAbortError());
				}
			};
			const onTimeout = () => {
				const index = state.queue.indexOf(entry);
				if (index >= 0) state.queue.splice(index, 1);
				if (entry.signal !== void 0) entry.signal.removeEventListener("abort", entry.onAbort);
				reject(concurrencyQueueTimeoutError());
			};
			state.queue.push(entry);
			timer = setTimeout(onTimeout, timeoutMs);
			if (signal !== void 0) {
				if (signal.aborted) entry.onAbort();
				else signal.addEventListener("abort", entry.onAbort, { once: true });
			}
		});
	}
	releaseOf(key, state) {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			state.inFlight -= 1;
			const next = state.queue.shift();
			if (next !== void 0) next.resolve();
			else if (state.inFlight === 0) this.states.delete(key);
		};
	}
};
//#endregion
//#region src/adapter.ts
/**
* SenseNova（OpenAI 兼容）provider 适配器（host 侧）。
*
* 复用参考插件 @mars-sea/dsh-commandcode-provider 的适配器结构，但只保留
* OpenAI 兼容的目录拉取与 SSE 流式翻译，外加「流开始前的 401 账号轮换」
* （429 不轮换：一个会话固定一个 key，保护服务端按 key 命中的 prompt 缓存，
* 429 交由宿主重试层退避后原 key 重试）。
* 与 pi-ai 的 `toStreamChunks` 不同，这里直接消费 OpenAI SSE（`data:` 行、
* `[DONE]`、`choices[].delta`、`finish_reason`、`usage`），不引入第三方流库。
*
* 适配器刻意不依赖 cordis/schemastery：每请求的连接事实与 key 解析/轮换
* 全部通过构造注入，node 测试可直接驱动。
*
* @module dsh-sensenova-provider/adapter
*/
/**
* SenseNova 目录通常不披露上下文字段，这里用 131072 作为合理默认
* （DeepSeek 系列与 SenseNova 常见模型窗口）；目录有字段时优先采用。
*/
const DEFAULT_CONTEXT_WINDOW = 131072;
const MODELS_TIMEOUT_MS = 1e4;
/**
* 提交给 provider 重试层的延迟上限（毫秒）：本地退避与非配额 429 的
* Retry-After 均受此约束，同时作为重试策略退避单次上限。
* fix-sensenova-429-quota-retry（2026-09-04 实测）：原 3000ms 与配额窗口量级
* 不符——TPM 为 60 秒窗口，提升到 60000ms（spec 允许区间 60–120s 的下沿）。
*/
const PROVIDER_RETRY_AFTER_CAP_MS = 6e4;
/** 配额类 429 退避指导（providerRetryAfterMs）的绝对上限（毫秒）：spec 允许区间 60–120s 的上沿，
* 防止网关异常 Retry-After 把退避拖到分钟级以外（design D2）。 */
const QUOTA_RETRY_AFTER_CEILING_MS = 12e4;
/** 配额类 429（code 8，rps/rpm exhausted）退避下限（毫秒）。2026-09-04 实测：速率桶补充 ≈1 个/14s，15s 覆盖一个完整补充周期。 */
const QUOTA_RATE_RETRY_FLOOR_MS = 15e3;
/** 配额类 429（code 429001，inference tpm exhausted）退避下限（毫秒）。2026-09-04 实测：TPM 按 60 秒窗口翻转。 */
const QUOTA_TPM_RETRY_FLOOR_MS = 6e4;
/** 已知不可路由的模型 id 清单（已下线路由，调用返回 404）。 */
const KNOWN_UNROUTABLE_MODELS = /* @__PURE__ */ new Set(["sensenova-6.7-flash-lite"]);
/** 明确的模型不可用错误码（不在默认可重试集合内，故不触发 provider 重试）。 */
const MODEL_NOT_FOUND_CODE = "MODEL_NOT_FOUND";
/** 模型 id → 标准显示名的显式品牌映射。 */
const DISPLAY_NAME_OVERRIDES = /* @__PURE__ */ new Map([["sensenova-6.7-flash-lite", "Sensenova 6.7 Flash Lite"]]);
/** 官方文档声明的模型族推理档位（值为 API wire 原值）。 */
const KNOWN_EFFORTS = /* @__PURE__ */ new Map([
	["sensenova-6.8-flash-lite", [
		"low",
		"medium",
		"high",
		"none"
	]],
	["deepseek-v4-flash", [
		"low",
		"medium",
		"high",
		"none"
	]],
	["deepseek-v4-pro", [
		"low",
		"high",
		"max"
	]],
	["glm-5.2", [
		"low",
		"medium",
		"high",
		"none"
	]],
	["kimi-k3", [
		"low",
		"high",
		"max"
	]]
]);
const EMPTY_MODEL_SELECTION = {
	include: [],
	exclude: []
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toString(value) {
	return typeof value === "string" ? value : void 0;
}
function toNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** 把模型 id 标准化为可读显示名：显式映射优先，否则按品牌前缀回退。 */
function displayNameFor(id) {
	const override = DISPLAY_NAME_OVERRIDES.get(id);
	if (override !== void 0) return override;
	const normalized = id.trim();
	const words = normalized.split(/[-_]+/).filter((part) => part !== "").flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/));
	if (words.length === 0) return normalized;
	return words.map((word) => word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word).join(" ").replace(/\s+/g, " ").trim();
}
/** 递归展平工具结果内容为纯文本。 */
function toolResultText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : "").join("");
}
/** 拼出某条消息的可见文本。 */
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** 从目录条目读取一个正数能力字段（按优先级），缺失/非法返回 undefined。 */
function firstPositiveNumber(raw, keys) {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
}
function firstContextField(raw) {
	return firstPositiveNumber(raw, [
		"context_length",
		"context_window",
		"max_context_length",
		"contextLength"
	]);
}
function firstMaxOutputField(raw) {
	return firstPositiveNumber(raw, [
		"max_output_length",
		"max_tokens",
		"max_output_tokens",
		"max_completion_tokens",
		"maxTokens",
		"maxOutputTokens",
		"maxCompletionTokens"
	]);
}
/** 把目录声明的输入模态映射为宿主 ModelModality 列表；未声明时回退 ['text']。 */
function inputModalitiesFrom(raw) {
	const declared = raw.input_modalities;
	if (!Array.isArray(declared)) return ["text"];
	const modalities = [];
	for (const item of declared) {
		const modality = toString(item);
		if (modality === "text" || modality === "image") {
			if (!modalities.includes(modality)) modalities.push(modality);
		}
	}
	return modalities.length > 0 ? modalities : ["text"];
}
/** 读取目录中的 effort 词表字段；返回字符串数组或 undefined（无明确词表）。 */
function effortListField(raw) {
	for (const key of ["reasoning_efforts", "reasoning_levels"]) {
		const value = raw[key];
		if (Array.isArray(value)) {
			const efforts = value.filter((item) => typeof item === "string" && item !== "");
			if (efforts.length > 0) return efforts;
		}
	}
}
/** 读取嵌套 reasoning.efforts / thinking.efforts 词表；返回字符串数组或 undefined。 */
function nestedEffortListField(raw) {
	for (const key of ["reasoning", "thinking"]) {
		const holder = raw[key];
		if (!isRecord(holder)) continue;
		const efforts = holder.efforts;
		if (Array.isArray(efforts)) {
			const list = efforts.filter((item) => typeof item === "string" && item !== "");
			if (list.length > 0) return list;
		}
	}
}
/** 读取目录中的默认 effort 字段；返回字符串或 undefined。 */
function defaultEffortField(raw) {
	const direct = raw.default_reasoning_effort;
	if (typeof direct === "string" && direct !== "") return direct;
	for (const key of ["reasoning", "thinking"]) {
		const holder = raw[key];
		if (isRecord(holder)) {
			const value = holder.defaultEffort ?? holder.default_effort;
			if (typeof value === "string" && value !== "") return value;
		}
	}
}
/** 目录是否声明支持 reasoning；仅用于静态已知模型族的档位补全。 */
function hasReasoningSupport(raw) {
	const features = raw.supported_features;
	if (Array.isArray(features) && features.includes("reasoning")) return true;
	if (raw.reasoning_effort !== void 0) return true;
	const thinking = raw.thinking;
	return thinking === true || isRecord(thinking);
}
/** 解析目录条目的 reasoning 词表；目录词表优先，静态表仅补全已知且有支持标记的模型。 */
function reasoningInfoFrom(raw, modelId) {
	const efforts = effortListField(raw) ?? nestedEffortListField(raw);
	const knownEfforts = KNOWN_EFFORTS.get(modelId);
	const selectedEfforts = efforts ?? (knownEfforts !== void 0 && hasReasoningSupport(raw) ? knownEfforts : void 0);
	if (selectedEfforts === void 0 || selectedEfforts.length === 0) return void 0;
	const infos = selectedEfforts.map((effort) => ({
		id: ReasoningEffortId(effort),
		name: effort
	}));
	const defaultEffort = efforts !== void 0 ? defaultEffortField(raw) : void 0;
	const defaultId = defaultEffort !== void 0 && selectedEfforts.includes(defaultEffort) ? ReasoningEffortId(defaultEffort) : void 0;
	return {
		efforts: infos,
		...defaultId !== void 0 ? { defaultEffort: defaultId } : {}
	};
}
/** 解析 OpenAI 模型目录为目录条目；应用自动过滤与手动 include/exclude 覆盖。 */
function parseCatalog(value, failedModels, selection) {
	if (!isRecord(value) || !Array.isArray(value.data)) throw new LlmError("llm-sensenova: unexpected models response shape", "PROVIDER_PROTOCOL_ERROR");
	const include = new Set(selection.include);
	const exclude = new Set(selection.exclude);
	const out = [];
	for (const raw of value.data) {
		if (!isRecord(raw)) continue;
		const id = toString(raw.id);
		if (id === void 0 || id === "") continue;
		const output = raw.output_modalities;
		if (!(Array.isArray(output) ? output.some((item) => toString(item) === "text") : false)) continue;
		if (exclude.has(id)) continue;
		if (!include.has(id)) {
			if (KNOWN_UNROUTABLE_MODELS.has(id)) continue;
			if (failedModels.has(id)) continue;
		}
		const contextWindow = firstContextField(raw);
		const maxOutputTokens = firstMaxOutputField(raw);
		const reasoning = reasoningInfoFrom(raw, id);
		out.push({
			id,
			name: displayNameFor(id),
			inputModalities: inputModalitiesFrom(raw),
			...contextWindow !== void 0 ? { contextWindow } : {},
			...maxOutputTokens !== void 0 ? { maxOutputTokens } : {},
			...reasoning !== void 0 ? { reasoning } : {}
		});
	}
	return out;
}
/** 把 OpenAI 消息历史翻译为 OpenAI 请求体消息数组。 */
function toOpenAiMessages(options) {
	const systemParts = [];
	if (options.system !== void 0 && options.system !== "") systemParts.push(options.system);
	for (const message of options.messages) if (message.role === "system") systemParts.push(flattenText(message));
	const systemText = systemParts.filter(Boolean).join("\n\n");
	const messages = [];
	if (systemText !== "") messages.push({
		role: "system",
		content: systemText
	});
	const toolCallIdRemap = /* @__PURE__ */ new Map();
	let syntheticToolCallSeq = 0;
	for (const message of options.messages) {
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			const text = flattenText(message);
			const toolCalls = message.content.filter((block) => block.type === "tool-call");
			const sanitizedCalls = [];
			for (const call of toolCalls) {
				if (call.name === "" || call.name === void 0) continue;
				syntheticToolCallSeq += 1;
				const keptId = call.id !== "" && call.id !== void 0 ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
				toolCallIdRemap.set(call.id, keptId);
				sanitizedCalls.push({
					id: keptId,
					type: "function",
					function: {
						name: call.name,
						arguments: call.arguments !== "" && call.arguments !== void 0 ? call.arguments : "{}"
					}
				});
			}
			if (text === "" && sanitizedCalls.length === 0) continue;
			const entry = {
				role: "assistant",
				content: text !== "" ? text : null
			};
			if (sanitizedCalls.length > 0) entry.tool_calls = sanitizedCalls;
			messages.push(entry);
			continue;
		}
		const text = flattenText(message);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (text !== "" || results.length === 0) messages.push({
			role: "user",
			content: text
		});
		for (const result of results) {
			const remappedId = toolCallIdRemap.get(result.toolCallId);
			if (remappedId === void 0) continue;
			messages.push({
				role: "tool",
				tool_call_id: remappedId,
				content: toolResultText(result.content) || "(no output)"
			});
		}
	}
	return messages;
}
/** 组装 OpenAI /chat/completions 请求体。 */
function buildOpenAiBody(options) {
	const tools = (options.tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	return {
		model: options.model,
		messages: toOpenAiMessages(options),
		stream: true,
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
		...options.stop !== void 0 && options.stop.length > 0 ? { stop: options.stop } : {},
		...tools.length > 0 ? { tools } : {},
		...options.reasoningEffort !== void 0 ? { reasoning_effort: options.reasoningEffort } : {}
	};
}
/** OpenAI usage → 宿主 TokenUsage（inputTokens 为未缓存输入，缓存读单独计）。 */
function mapUsage(usage) {
	const prompt = toNumber(usage.prompt_tokens);
	const completion = toNumber(usage.completion_tokens);
	const total = toNumber(usage.total_tokens);
	const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : void 0;
	const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : void 0;
	const cacheRead = promptDetails !== void 0 ? toNumber(promptDetails.cached_tokens) : 0;
	const reasoning = completionDetails !== void 0 ? toNumber(completionDetails.reasoning_tokens) : 0;
	return {
		inputTokens: Math.max(0, prompt - cacheRead),
		outputTokens: completion,
		totalTokens: total > 0 ? total : prompt + completion,
		...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning > 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** OpenAI finish_reason → 宿主 FinishReason。 */
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls":
		case "function_call": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: "SenseNova stream aborted",
				code: "ABORTED"
			}
		};
		default: return { kind: "stop" };
	}
}
/** 解析一行 SSE；返回解析后的数据对象，`[DONE]` 或空行/注释行返回 undefined。 */
function parseSseDataLine(line) {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":")) return void 0;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return void 0;
	try {
		return JSON.parse(trimmed);
	} catch {
		return;
	}
}
function createSseState() {
	return {
		nextIndex: 0,
		textIndex: -1,
		textContent: "",
		reasoningIndex: -1,
		reasoningContent: "",
		toolIndexById: /* @__PURE__ */ new Map(),
		toolIndexByProtocolIndex: /* @__PURE__ */ new Map(),
		toolIndexByAnonymousName: /* @__PURE__ */ new Map(),
		lastAnonymousIndex: -1,
		toolIdByIndex: /* @__PURE__ */ new Map(),
		toolNameByIndex: /* @__PURE__ */ new Map(),
		toolArgsByIndex: /* @__PURE__ */ new Map(),
		sawContent: false,
		pendingUsage: void 0,
		usageEmitted: false,
		finished: false
	};
}
function closeText(state) {
	if (state.textIndex < 0) return [];
	const chunk = {
		type: "block-end",
		index: state.textIndex,
		block: {
			type: "text",
			text: state.textContent
		}
	};
	state.textIndex = -1;
	state.textContent = "";
	return [chunk];
}
function closeReasoning(state) {
	if (state.reasoningIndex < 0) return [];
	const chunk = {
		type: "block-end",
		index: state.reasoningIndex,
		block: {
			type: "reasoning",
			text: state.reasoningContent
		}
	};
	state.reasoningIndex = -1;
	state.reasoningContent = "";
	return [chunk];
}
function closeToolCalls(state) {
	const chunks = [];
	for (const [index, args] of [...state.toolArgsByIndex.entries()]) {
		const name = state.toolNameByIndex.get(index) ?? "";
		if (name === "") continue;
		const id = state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`;
		chunks.push({
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id: ToolCallId(id),
				name,
				arguments: args !== "" ? args : "{}"
			}
		});
	}
	state.toolArgsByIndex.clear();
	state.toolIdByIndex.clear();
	state.toolNameByIndex.clear();
	state.toolIndexById.clear();
	state.toolIndexByProtocolIndex.clear();
	state.toolIndexByAnonymousName.clear();
	state.lastAnonymousIndex = -1;
	return chunks;
}
/** 将事件中的 usage 转成单次 usage chunk，避免 finish/trailing 重复发出。 */
function usageChunksFrom(event, state) {
	if (state.usageEmitted || !isRecord(event)) return [];
	const usageRec = isRecord(event.usage) ? event.usage : void 0;
	if (state.pendingUsage === void 0 && usageRec === void 0) return [];
	const usage = state.pendingUsage ?? mapUsage(usageRec);
	state.pendingUsage = void 0;
	state.usageEmitted = true;
	return [{
		type: "usage",
		usage
	}];
}
/** 处理一个 OpenAI SSE 数据对象，返回对应的宿主 StreamChunk 序列。 */
function processChunkEvent(event, state) {
	if (!isRecord(event)) return [];
	const choices = event.choices;
	if (!Array.isArray(choices)) return usageChunksFrom(event, state);
	const chunks = [];
	for (const rawChoice of choices) {
		if (state.finished) break;
		if (!isRecord(rawChoice)) continue;
		const delta = isRecord(rawChoice.delta) ? rawChoice.delta : void 0;
		const finishReasonRaw = rawChoice.finish_reason;
		const finishReason = typeof finishReasonRaw === "string" && finishReasonRaw !== "" && finishReasonRaw !== "null" ? finishReasonRaw : void 0;
		if (delta !== void 0) {
			const content = toString(delta.content) ?? "";
			const reasoning = toString(delta.reasoning_content) ?? toString(delta.reasoning) ?? "";
			const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : [];
			if (reasoning !== "") {
				chunks.push(...closeText(state));
				if (state.reasoningIndex < 0) {
					state.reasoningIndex = state.nextIndex;
					state.nextIndex += 1;
					chunks.push({
						type: "block-start",
						index: state.reasoningIndex,
						blockType: "reasoning"
					});
				}
				state.reasoningContent += reasoning;
				chunks.push({
					type: "reasoning-delta",
					index: state.reasoningIndex,
					text: reasoning
				});
			}
			if (content !== "") {
				chunks.push(...closeReasoning(state));
				if (state.textIndex < 0) {
					state.textIndex = state.nextIndex;
					state.nextIndex += 1;
					chunks.push({
						type: "block-start",
						index: state.textIndex,
						blockType: "text"
					});
				}
				state.textContent += content;
				state.sawContent = true;
				chunks.push({
					type: "text-delta",
					index: state.textIndex,
					text: content
				});
			}
			for (const tc of toolCalls) {
				const id = toString(tc.id) ?? "";
				const protocolIndex = typeof tc.index === "number" && Number.isInteger(tc.index) ? tc.index : void 0;
				const fn = isRecord(tc.function) ? tc.function : void 0;
				const name = fn !== void 0 ? toString(fn.name) ?? "" : "";
				const argsDelta = fn !== void 0 ? toString(fn.arguments) ?? "" : "";
				let index;
				if (protocolIndex !== void 0) index = state.toolIndexByProtocolIndex.get(protocolIndex);
				else if (id !== "") index = state.toolIndexById.get(id);
				else if (name !== "") index = state.toolIndexByAnonymousName.get(name);
				else index = state.lastAnonymousIndex >= 0 ? state.lastAnonymousIndex : void 0;
				if (index === void 0) {
					chunks.push(...closeText(state), ...closeReasoning(state));
					index = state.nextIndex;
					state.nextIndex += 1;
					if (protocolIndex !== void 0) state.toolIndexByProtocolIndex.set(protocolIndex, index);
					if (id !== "") state.toolIndexById.set(id, index);
					if (name !== "" && protocolIndex === void 0 && id === "") {
						state.toolIndexByAnonymousName.set(name, index);
						state.lastAnonymousIndex = index;
					}
					state.toolIdByIndex.set(index, id);
					state.toolNameByIndex.set(index, name);
					state.toolArgsByIndex.set(index, "");
					chunks.push({
						type: "block-start",
						index,
						blockType: "tool-call"
					});
					state.sawContent = true;
				}
				if (id !== "") {
					state.toolIdByIndex.set(index, id);
					state.toolIndexById.set(id, index);
				}
				if (name !== "") state.toolNameByIndex.set(index, name);
				if (protocolIndex === void 0 && id === "" && name !== "") {
					state.toolIndexByAnonymousName.set(name, index);
					state.lastAnonymousIndex = index;
				}
				const accumulated = (state.toolArgsByIndex.get(index) ?? "") + argsDelta;
				state.toolArgsByIndex.set(index, accumulated);
				const effectiveName = state.toolNameByIndex.get(index) ?? "";
				chunks.push({
					type: "tool-call-delta",
					index,
					id: ToolCallId(state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`),
					...effectiveName !== "" ? { name: effectiveName } : {},
					argumentsDelta: argsDelta
				});
			}
		}
		if (finishReason !== void 0) {
			state.finished = true;
			chunks.push(...closeText(state), ...closeReasoning(state), ...closeToolCalls(state));
			chunks.push(...usageChunksFrom(event, state));
			chunks.push({
				type: "finish",
				reason: mapFinishReason(finishReason)
			});
			continue;
		}
		const usageRec = isRecord(event.usage) ? event.usage : void 0;
		if (usageRec !== void 0 && state.pendingUsage === void 0) state.pendingUsage = mapUsage(usageRec);
	}
	return chunks;
}
/** 把 OpenAI SSE 响应体翻译为宿主 StreamChunk 序列。 */
async function* parseOpenAiSse(body, signal, idleTimeoutMs) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state = createSseState();
	let buffer = "";
	let finished = false;
	let watchdogReject;
	let watchdogTimer;
	const armWatchdog = () => {
		if (watchdogTimer !== void 0) clearTimeout(watchdogTimer);
		watchdogTimer = setTimeout(() => {
			watchdogReject?.(new DOMException(`SenseNova stream idle for ${idleTimeoutMs}ms`, "TimeoutError"));
		}, idleTimeoutMs);
	};
	const disarmWatchdog = () => {
		if (watchdogTimer !== void 0) {
			clearTimeout(watchdogTimer);
			watchdogTimer = void 0;
		}
	};
	try {
		for (;;) {
			const read = await new Promise((resolve, reject) => {
				watchdogReject = reject;
				reader.read().then(resolve, reject);
				armWatchdog();
			});
			disarmWatchdog();
			const { done, value } = read;
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const event = parseSseDataLine(line);
				if (event === void 0) continue;
				if (finished) {
					for (const chunk of usageChunksFrom(event, state)) yield chunk;
					continue;
				}
				for (const chunk of processChunkEvent(event, state)) {
					yield chunk;
					if (chunk.type === "finish") finished = true;
				}
			}
		}
		if (buffer.trim() !== "") {
			const event = parseSseDataLine(buffer);
			if (event !== void 0) {
				if (finished) for (const chunk of usageChunksFrom(event, state)) yield chunk;
				else for (const chunk of processChunkEvent(event, state)) {
					yield chunk;
					if (chunk.type === "finish") finished = true;
				}
			}
		}
		if (!finished) {
			const trailing = [
				...closeText(state),
				...closeReasoning(state),
				...closeToolCalls(state)
			];
			for (const chunk of trailing) yield chunk;
			if (!state.sawContent) throw new LlmError("llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复", "EMPTY_RESPONSE");
			if (state.pendingUsage !== void 0) yield {
				type: "usage",
				usage: state.pendingUsage
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		}
	} catch (error) {
		if (signal?.aborted && isTimeoutReason(signal.reason) || isTimeoutReason(error)) throw new LlmError(`llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`, "TIMEOUT", { cause: error });
		if (signal?.aborted || error instanceof LlmError) throw error;
		throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, "TRANSPORT", { cause: error });
	} finally {
		disarmWatchdog();
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
/** 判断错误文本是否为「模型不可路由」的 404 措辞。 */
function isModelNotFoundText(errText) {
	const lower = errText.toLowerCase();
	return lower.includes("model route not found") || lower.includes("model is not found");
}
/** 是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason(value) {
	return value instanceof Error && value.name === "TimeoutError";
}
/**
* 解析 429 响应体并按 error.code 二分类（design D1，2026-09-04 实测）：
* 配额类 = code 8（rps/rpm exhausted，速率桶补充 ≈1 个/14s）或 code 429001
* （inference tpm exhausted，TPM 60s 窗口；code 实测可能是数字或字符串，做容错）。
* 其余（含无 code、非 JSON 体、解析失败）归非配额类，维持现行短退避语义。
* 按 code 而非 message/type 分类：message 措辞随版本漂移（同 code 8 出现过
* `rps exhausted` 与 `rpm exhausted`），429001 的 type 实测为 invalid_request_error
* 而非官方错误表标注的 quota_exceeded_error，按 type 分类会漏掉 TPM 类。
*/
function classify429Body(bodyText) {
	let parsed;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return {
			quota: false,
			retryFloorMs: void 0
		};
	}
	if (!isRecord(parsed) || !isRecord(parsed.error)) return {
		quota: false,
		retryFloorMs: void 0
	};
	const code = parsed.error.code;
	if (typeof code !== "number" && typeof code !== "string") return {
		quota: false,
		retryFloorMs: void 0
	};
	if (code === 8 || code === "8") return {
		quota: true,
		retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS
	};
	if (code === 429001 || code === "429001") return {
		quota: true,
		retryFloorMs: QUOTA_TPM_RETRY_FLOOR_MS
	};
	return {
		quota: false,
		retryFloorMs: void 0
	};
}
/** 把预流 HTTP 失败映射为稳定 LlmError。 */
function httpError(status, errText, retryAfterMs) {
	if (status === 401) return new LlmError("llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效", "INVALID_CREDENTIAL", { status: 401 });
	if (status === 404 && isModelNotFoundText(errText)) return new LlmError("llm-sensenova: SenseNova model is not routable — the model id is no longer served；SenseNova 模型不可路由：该模型 id 已下线", MODEL_NOT_FOUND_CODE, { status: 404 });
	if (status === 429) {
		const classified = classify429Body(errText);
		let providerRetryAfterMs;
		if (classified.retryFloorMs !== void 0) providerRetryAfterMs = Math.min(Math.max(classified.retryFloorMs, retryAfterMs !== void 0 && retryAfterMs > 0 ? retryAfterMs : 0), QUOTA_RETRY_AFTER_CEILING_MS);
		else providerRetryAfterMs = retryAfterMs !== void 0 && retryAfterMs > 0 && retryAfterMs <= PROVIDER_RETRY_AFTER_CAP_MS ? retryAfterMs : void 0;
		return new LlmError("llm-sensenova: SenseNova API error 429 — rate limited；SenseNova API 返回 429：请求被限流", "RATE_LIMIT", {
			status: 429,
			...providerRetryAfterMs !== void 0 ? { providerRetryAfterMs } : {}
		});
	}
	return new LlmError(`llm-sensenova: SenseNova API error ${status}: ${errText.slice(0, 500)}`, "PROVIDER_HTTP_ERROR", { status });
}
/** SenseNova（OpenAI 兼容）适配器。 */
var SensenovaAdapter = class extends LlmAdapter {
	deps;
	fetchImpl;
	gate;
	catalog = [];
	/** 进程内失败缓存：运行时返回 MODEL_NOT_FOUND 的模型 id，直到适配器生命周期结束。 */
	failedModels = /* @__PURE__ */ new Set();
	/**
	* 配额类 429 粘住 key（design D5，仅 quotaRotation 开启时读写）：
	* 有 sessionId 的请求按会话分桶（同一会话后续请求粘住切换后的 key）；
	* 无 sessionId 的请求共享进程级桶（undefined 键）——宿主 GenerateOptions
	* 仅提供 sessionId 这一会话标识，粘性粒度即「会话（无标识时为进程）」，
	* 与 spec「同一会话后续请求继续使用新 key」对齐。条目仅存内存，随适配器
	* 生命周期结束。
	*/
	quotaStickyKeys = /* @__PURE__ */ new Map();
	/**
	* 配额轮换「已环回」标记（design D5）：某会话按序试完所有可用 key 均被配额类
	* 429 拒绝后记录，后续请求停留在当前 key 按退避下限等待、不再轮换，避免双 key
	* 都饱和时宿主每轮重试都乒乓切换；该会话任一请求成功（配额恢复）后清除。
	*/
	quotaRingExhausted = /* @__PURE__ */ new Set();
	constructor(deps) {
		super();
		this.deps = deps;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.gate = deps.concurrencyGate ?? new KeyedConcurrencyGate();
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "SenseNova"
		};
	}
	providerRetryPolicy(_provider) {
		return resolveRetryPolicy({
			mode: "normal",
			maxRetries: 10,
			backoff: { maxDelayMs: PROVIDER_RETRY_AFTER_CAP_MS }
		}, "llm-sensenova.retryPolicy");
	}
	async listModels(provider) {
		const connection = this.deps.options();
		let apiKey;
		try {
			apiKey = await this.deps.resolveApiKey(connection);
		} catch {
			return [];
		}
		const response = await this.fetchImpl(`${connection.apiBase}/models`, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${apiKey}`,
				...attributionHeaders()
			},
			signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
		});
		if (response.status === 401) throw new LlmError("llm-sensenova: SenseNova API rejected the API key (401)", "INVALID_CREDENTIAL", { status: 401 });
		if (!response.ok) throw new LlmError(`llm-sensenova: models endpoint returned HTTP ${response.status}`, "PROVIDER_HTTP_ERROR", { status: response.status });
		const models = parseCatalog(await response.json(), this.failedModels, connection.modelSelection ?? EMPTY_MODEL_SELECTION);
		this.catalog = models;
		return models.map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			inputModalities: model.inputModalities
		}));
	}
	async resolveModel(provider, model, _signal) {
		const entry = this.catalog.find((m) => m.id === model);
		const contextWindow = entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		return {
			provider,
			id: model,
			name: entry?.name ?? displayNameFor(model),
			inputModalities: entry?.inputModalities ?? ["text"],
			context: { contextWindow },
			...entry?.maxOutputTokens !== void 0 ? { defaultMaxTokens: entry.maxOutputTokens } : {},
			...entry?.reasoning !== void 0 ? { reasoning: entry.reasoning } : {}
		};
	}
	async *stream(options) {
		const connection = this.deps.options();
		const body = JSON.stringify(buildOpenAiBody(options));
		const tried = /* @__PURE__ */ new Set();
		const limit = connection.concurrency;
		const connectMs = this.deps.timeouts?.connectMs ?? 45e3;
		const streamIdleMs = this.deps.timeouts?.streamIdleMs ?? 6e4;
		const queueMs = this.deps.timeouts?.queueMs;
		const quotaRotation = connection.quotaRotation === true;
		let apiKey = (quotaRotation ? this.quotaStickyKeys.get(options.sessionId) : void 0) ?? await this.deps.resolveApiKey(connection);
		let response;
		let release;
		const connectCleanups = [];
		try {
			for (let rotations = 0;;) {
				tried.add(apiKey);
				try {
					release = await this.gate.acquire(apiKey, limit, options.signal, queueMs);
				} catch (error) {
					if (!isTimeoutReason(error)) throw error;
					throw new LlmError(`llm-sensenova: request queued behind the per-key concurrency limit for over ${queueMs ?? 6e4}ms；SenseNova 请求排队超时（未占用并发额度），交宿主重试层退避后重试`, "TIMEOUT", { cause: error });
				}
				let attempt;
				try {
					const connectController = new AbortController();
					const connectTimer = setTimeout(() => {
						connectController.abort(new DOMException("connect timed out", "TimeoutError"));
					}, connectMs);
					const onHostAbort = () => connectController.abort(options.signal?.reason);
					if (options.signal !== void 0) {
						if (options.signal.aborted) connectController.abort(options.signal.reason);
						else options.signal.addEventListener("abort", onHostAbort, { once: true });
					}
					connectCleanups.push(() => {
						clearTimeout(connectTimer);
						options.signal?.removeEventListener("abort", onHostAbort);
					});
					attempt = await this.fetchImpl(`${connection.apiBase}/chat/completions`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${apiKey}`,
							...attributionHeaders()
						},
						body,
						signal: connectController.signal
					});
					clearTimeout(connectTimer);
				} catch (error) {
					release();
					release = void 0;
					if (options.signal?.aborted) throw error;
					if (isTimeoutReason(error)) throw new LlmError(`llm-sensenova: request to ${connection.apiBase} timed out after ${connectMs}ms；SenseNova 请求建连或首包超时（已释放并发额度），交宿主重试层处理`, "TIMEOUT", { cause: error });
					throw new LlmError(`llm-sensenova: request to ${connection.apiBase} failed: ${errorChain(error)}；连接 SenseNova API 失败，通常是网络或代理问题`, "TRANSPORT", { cause: error });
				}
				if (attempt.ok) {
					response = attempt;
					if (quotaRotation) this.quotaRingExhausted.delete(options.sessionId);
					break;
				}
				const errText = await attempt.text().catch(() => "");
				const retryAfterMs = parseRetryAfterMs(attempt.headers.get("retry-after"));
				if (attempt.status === 404 && isModelNotFoundText(errText)) {
					release();
					release = void 0;
					this.failedModels.add(options.model);
					throw httpError(attempt.status, errText, retryAfterMs);
				}
				const classified = classify429Body(errText);
				const quota429 = attempt.status === 429 && classified.quota;
				const quotaRotate = quota429 && quotaRotation && !this.quotaRingExhausted.has(options.sessionId);
				if ((attempt.status === 401 || quotaRotate) && options.signal?.aborted !== true && rotations < connection.accountCount) {
					const next = await this.deps.rotateApiKey(apiKey, attempt.status === 401 ? "invalid-credential" : "quota-exhausted");
					if (next !== void 0 && !tried.has(next)) {
						release();
						release = void 0;
						apiKey = next;
						rotations += 1;
						if (quotaRotate) {
							this.quotaStickyKeys.set(options.sessionId, next);
							this.quotaRingExhausted.delete(options.sessionId);
						}
						continue;
					}
				}
				if (quota429 && quotaRotation) this.quotaRingExhausted.add(options.sessionId);
				release();
				release = void 0;
				throw httpError(attempt.status, errText, retryAfterMs);
			}
			if (response === void 0) throw new LlmError("llm-sensenova: SenseNova API returned no response", "PROVIDER_PROTOCOL_ERROR");
			if (response.body === null) throw new LlmError("llm-sensenova: SenseNova API returned no response body", "PROVIDER_PROTOCOL_ERROR");
			yield* parseOpenAiSse(response.body, options.signal, streamIdleMs);
		} finally {
			for (const cleanup of connectCleanups) cleanup();
			release?.();
		}
	}
};
//#endregion
//#region src/index.ts
/**
* dsh-sensenova-provider — DeepSeek Harness 的 SenseNova（OpenAI 兼容）LLM
* provider 插件（host 侧）。
*
* 注册 `sensenova` 路由并声明为可配置 provider（显示名 SenseNova），在 Models
* 页提供卡片；设置段挂在 `llm-sensenova` 命名空间下，支持共享 `apiBase` 下
* 的默认账号 + 多账号列表 + 手动钉选（activeAccount）。key 一律通过宿主
* 凭据服务解析（环境变量兜底），原文不落日志。
*
* ```yaml
* - id: llm-sensenova
*   name: "@alaxrpg/dsh-sensenova-provider"
*   config:
*     apiKeyEnv: SENSENOVA_API_KEY
* ```
*
* `name` 必须是完整包名（加载器按真实包名从 node_modules 解析）；YAML 中以
* `@` 开头的标量必须加引号。
*
* @module dsh-sensenova-provider
*/
const name = "llm-sensenova";
const inject = ["llm"];
const NS = "llm-sensenova";
const PROVIDER = "sensenova";
const DEFAULT_API_KEY_ENV = "SENSENOVA_API_KEY";
const DEFAULT_API_BASE = "https://token.sensenova.cn/v1";
const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	apiBase: z.string().default(DEFAULT_API_BASE),
	accounts: z.array(z.object({
		id: z.string().default(""),
		label: z.string().default(""),
		apiKeyEnv: z.string().role("credential-ref").default("")
	})).default([]),
	activeAccount: z.string().default(""),
	modelSelection: z.object({
		include: z.array(z.string()).default([]),
		exclude: z.array(z.string()).default([])
	}),
	concurrency: z.natural().min(1).default(1),
	quotaRotation: z.boolean().default(false)
});
/** 把配置的并发上限归一化为正整数（非正整数/无法解析回退 1）。 */
function normalizeConcurrency(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}
/** 领域层规范化模型 id：去除首尾空白、过滤空项、稳定去重。 */
function normalizeModelIds(value) {
	if (!Array.isArray(value)) return [];
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const id = item.trim();
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}
/** 规范化用户模型选择配置；未配置时保持 undefined，便于 settings unset。 */
function normalizeModelSelection(selection) {
	if (selection === void 0 || selection === null || typeof selection !== "object") return void 0;
	return {
		include: normalizeModelIds(selection.include),
		exclude: normalizeModelIds(selection.exclude)
	};
}
function resolveSlot(id, label, value) {
	const ref = typeof value === "string" ? value.trim() : "";
	return isCredentialRefName(ref) ? {
		id,
		label,
		ref,
		isLiteral: false
	} : {
		id,
		label,
		ref: "",
		isLiteral: false
	};
}
/**
* 从原始 config 到解析后连接事实的唯一显式步骤。程序化构造可能绕过
* Schemastery 归一化，因此每个默认值在此重新判定——既用于加载时的组合配置，
* 也用于 settings 快照首次使用。
*/
function resolveAdapterOptions(config) {
	const accounts = [];
	const defaultEnv = config.apiKeyEnv ?? "SENSENOVA_API_KEY";
	accounts.push(resolveSlot("default", "Default", defaultEnv));
	for (const [index, account] of (config.accounts ?? []).entries()) {
		if (account === void 0) continue;
		const refName = typeof account.apiKeyEnv === "string" && account.apiKeyEnv.trim() !== "" ? account.apiKeyEnv.trim() : void 0;
		if (refName === void 0) continue;
		const id = typeof account.id === "string" && account.id.trim() !== "" ? account.id.trim() : `account-${index + 2}`;
		const label = typeof account.label === "string" && account.label.trim() !== "" ? account.label.trim() : `Account ${index + 2}`;
		accounts.push(resolveSlot(id, label, refName));
	}
	const modelSelection = normalizeModelSelection(config.modelSelection);
	return {
		apiBase: config.apiBase ?? "https://token.sensenova.cn/v1",
		activeAccount: typeof config.activeAccount === "string" ? config.activeAccount : "",
		accounts,
		concurrency: normalizeConcurrency(config.concurrency),
		quotaRotation: config.quotaRotation === true,
		...modelSelection !== void 0 ? { modelSelection } : {}
	};
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		const next = resolveAdapterOptions(raw);
		lastRaw = raw;
		lastGood = next;
		return next;
	};
	options();
	const resolveRef = async (spec) => {
		if (spec.isLiteral || !isCredentialRefName(spec.ref)) return void 0;
		const ref = credentialRef(spec.ref);
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const resolved = await credentials.resolve(ref);
			if (resolved !== void 0 && resolved.value !== void 0 && resolved.value !== "") return resolved.value;
		}
		const ambient = launchEnvironmentOf(ctx).get(spec.ref);
		if (ambient !== void 0 && ambient.value.length > 0) return ambient.value;
	};
	const slots = () => options().accounts.map((spec) => ({
		id: spec.id,
		label: spec.label,
		resolveKey: () => resolveRef(spec)
	}));
	const preferredId = () => {
		const active = options().activeAccount;
		return active !== "" ? active : void 0;
	};
	const pool = new SensenovaAccountPool({
		slots,
		preferredId
	});
	const resolveApiKey = async (connection) => {
		const resolved = await pool.resolveKey();
		if (resolved !== void 0) return assertUsableApiKey(resolved.key, "llm-sensenova", resolved.slot.label);
		throw new LlmError(`llm-sensenova: no API key for provider route "${PROVIDER}" (apiBase ${connection.apiBase}); store a key through the credentials service or settings；未配置 SenseNova API 密钥，请在设置页或凭据页配置`, "MISSING_CREDENTIAL");
	};
	const rotateApiKey = async (rejectedKey, rejection) => {
		pool.markRejected(rejectedKey, rejection);
		const resolved = await pool.resolveKey({ exclude: rejectedKey });
		if (resolved === void 0) return void 0;
		return assertUsableApiKey(resolved.key, "llm-sensenova", resolved.slot.label);
	};
	const adapter = new SensenovaAdapter({
		options: () => {
			const resolved = options();
			return {
				apiBase: resolved.apiBase,
				accountCount: resolved.accounts.length,
				concurrency: resolved.concurrency,
				quotaRotation: resolved.quotaRotation,
				...resolved.modelSelection !== void 0 ? { modelSelection: resolved.modelSelection } : {}
			};
		},
		resolveApiKey,
		rotateApiKey
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "SenseNova",
		settingsNs: NS,
		settingsPath: []
	}]);
	ctx.llm.registerAdapter([PROVIDER], adapter);
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, NS, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {
				lastRaw = void 0;
				lastGood = void 0;
			}
		});
	});
}
//#endregion
export { Config, DEFAULT_API_BASE, DEFAULT_API_KEY_ENV, apply, inject, name, normalizeConcurrency, normalizeModelSelection, resolveAdapterOptions };

//# sourceMappingURL=index.js.map