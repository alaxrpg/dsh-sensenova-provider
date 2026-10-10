import z from "@deepseek-ai/schemastery";
import { LlmAdapter, LlmError, ReasoningEffortId, assertUsableApiKey, attributionHeaders, contentHasImage, errorChain, offloadedImageText, projectImagesForTextModel, resolveRetryPolicy, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { readFile } from "node:fs/promises";
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
//#region src/brand.ts
/**
* Brand a string as a {@link ToolCallId}.
* @param id - the provider-issued or synthesized call id.
* @returns the same string with the compile-time tool-call-id brand.
*/
function ToolCallId(id) {
	return id;
}
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
//#region src/wire/facts.ts
/** 未收录模型 id 的通用兜底档案（不抛错；Chat 行为与迁移前「未知模型」路径一致）。 */
const GENERIC_FACTS = {
	id: "",
	supportedWires: ["chat-completions"],
	efforts: [],
	defaultEffort: null,
	responsesDefaultEffort: null,
	outputLimitField: "max_tokens",
	outputLimitMax: null,
	supportsStreamOptions: false,
	requiresReasoningReplay: false,
	forbidThinkingDisabled: false,
	noneMapsToThinkingDisabled: false,
	fixedTemperature: null,
	fixedTopP: null,
	blockedSampling: [],
	supportsImages: false,
	imageFormats: [],
	imageRequiresBase64: false,
	responsesMaxOutputTokens: null,
	responsesSupportsJsonSchema: false
};
/** 静态档案表（deepseek-v4-pro 已下线，不收录）。
* 行号锚点：6.8 参数表 :543-560；v4-flash :1288-1320；deepseek-flash :1665-1673；
* glm-5.2 :2022 起；kimi-k3 :2403-2451；Responses §3.2（升级计划 docs/sensenova-upgrade-plan.md:111-114）。 */
const STATIC_FACTS = /* @__PURE__ */ new Map([
	["sensenova-6.8-flash-lite", {
		id: "sensenova-6.8-flash-lite",
		supportedWires: ["chat-completions", "responses"],
		efforts: [
			"low",
			"medium",
			"high",
			"max",
			"none"
		],
		defaultEffort: "high",
		responsesDefaultEffort: "high",
		outputLimitField: "max_tokens",
		outputLimitMax: 65536,
		supportsStreamOptions: true,
		requiresReasoningReplay: false,
		forbidThinkingDisabled: false,
		noneMapsToThinkingDisabled: false,
		fixedTemperature: null,
		fixedTopP: null,
		blockedSampling: [],
		samplingParameters: [
			"seed",
			"n",
			"parallel_tool_calls"
		],
		supportsImages: true,
		imageFormats: [
			"jpg",
			"jpeg",
			"png",
			"webp"
		],
		imageRequiresBase64: false,
		responsesMaxOutputTokens: 65536,
		responsesSupportsJsonSchema: false
	}],
	["deepseek-v4-flash", {
		id: "deepseek-v4-flash",
		supportedWires: ["chat-completions", "responses"],
		efforts: [
			"low",
			"medium",
			"high",
			"max",
			"none"
		],
		defaultEffort: "high",
		responsesDefaultEffort: "high",
		outputLimitField: "max_tokens",
		outputLimitMax: 384e3,
		supportsStreamOptions: true,
		requiresReasoningReplay: true,
		forbidThinkingDisabled: false,
		noneMapsToThinkingDisabled: false,
		fixedTemperature: null,
		fixedTopP: null,
		blockedSampling: [],
		supportsImages: false,
		imageFormats: [],
		imageRequiresBase64: false,
		responsesMaxOutputTokens: 384e3,
		responsesSupportsJsonSchema: false
	}],
	["deepseek-flash", {
		id: "deepseek-flash",
		supportedWires: ["chat-completions", "responses"],
		efforts: [
			"none",
			"low",
			"high",
			"max"
		],
		defaultEffort: "high",
		responsesDefaultEffort: "high",
		effortCompat: {
			minimal: "low",
			medium: "high",
			xhigh: "high",
			ultra: "max"
		},
		outputLimitField: "max_tokens",
		outputLimitMax: 393216,
		supportsStreamOptions: true,
		requiresReasoningReplay: true,
		forbidThinkingDisabled: false,
		noneMapsToThinkingDisabled: false,
		fixedTemperature: null,
		fixedTopP: null,
		blockedSampling: [],
		supportsImages: true,
		imageFormats: [
			"jpeg",
			"png",
			"gif",
			"webp"
		],
		imageRequiresBase64: false,
		responsesMaxOutputTokens: null,
		responsesSupportsJsonSchema: true
	}],
	["glm-5.2", {
		id: "glm-5.2",
		supportedWires: ["chat-completions", "responses"],
		efforts: [
			"max",
			"xhigh",
			"high",
			"medium",
			"low",
			"minimal",
			"none"
		],
		defaultEffort: "max",
		responsesDefaultEffort: "max",
		outputLimitField: "max_tokens",
		outputLimitMax: 131072,
		supportsStreamOptions: false,
		requiresReasoningReplay: false,
		forbidThinkingDisabled: true,
		noneMapsToThinkingDisabled: false,
		fixedTemperature: null,
		fixedTopP: null,
		blockedSampling: [],
		supportsImages: false,
		imageFormats: [],
		imageRequiresBase64: false,
		responsesMaxOutputTokens: 131072,
		responsesSupportsJsonSchema: false
	}],
	["kimi-k3", {
		id: "kimi-k3",
		supportedWires: ["chat-completions", "responses"],
		efforts: [
			"low",
			"medium",
			"high",
			"max"
		],
		defaultEffort: "max",
		responsesDefaultEffort: "max",
		outputLimitField: "max_completion_tokens",
		outputLimitMax: 1048576,
		supportsStreamOptions: true,
		requiresReasoningReplay: false,
		forbidThinkingDisabled: false,
		noneMapsToThinkingDisabled: true,
		fixedTemperature: 1,
		fixedTopP: .95,
		blockedSampling: [
			"frequency_penalty",
			"presence_penalty",
			"temperature",
			"top_p"
		],
		samplingParameters: ["seed", "parallel_tool_calls"],
		supportsImages: true,
		imageFormats: [
			"jpeg",
			"png",
			"webp",
			"gif",
			"bmp",
			"heic",
			"heif"
		],
		imageRequiresBase64: true,
		responsesMaxOutputTokens: 1048576,
		responsesSupportsJsonSchema: true
	}]
]);
/** 静态档案查询（未收录返回 undefined；adapter 的目录解析路径使用）。 */
function staticFacts(model) {
	return STATIC_FACTS.get(model);
}
/** 目录实测值 > 静态档案：context/max_output/input_modalities/supported_sampling_parameters
* 覆盖静态对应项，缺失回退静态；未知目录字段宽容忽略；未收录模型返回通用兜底（不抛错）。 */
function factsFor(model, entry) {
	const base = STATIC_FACTS.get(model);
	if (base === void 0) return {
		...GENERIC_FACTS,
		id: model,
		outputLimitMax: entry?.maxOutputTokens ?? null,
		...entry?.supportedSamplingParameters !== void 0 ? { samplingParameters: entry.supportedSamplingParameters } : {}
	};
	const outputLimitMax = entry?.maxOutputTokens ?? base.outputLimitMax;
	const supportsImages = entry?.inputModalities.includes("image") ?? base.supportsImages;
	const imageFormats = supportsImages ? base.imageFormats.length > 0 ? base.imageFormats : [
		"jpeg",
		"png",
		"webp",
		"gif"
	] : [];
	return {
		...base,
		outputLimitMax,
		supportsImages,
		imageFormats,
		...entry?.supportedSamplingParameters !== void 0 ? { samplingParameters: entry.supportedSamplingParameters } : {}
	};
}
//#endregion
//#region src/wire/blocks.ts
/** 内容块 → wire 出站项翻译（add-multimodal-input 1.x；规划 §6.3、design 决策 1/2/5）。
*
* 双分支形态（硬约束，测试断言形状）：
* - chat：`{type:'image_url', image_url:{url}}`（嵌套）+ `{type:'text', text}`；
* - responses：`{type:'input_image', image_url}`（**扁平字段**）+ `{type:'input_text', text}`。
*
* 图像数据流（design 前提假设，0.1.7-rc.2 类型面）：ImageBlock 只携带
* `attachment: ImageAttachmentRef`（attachmentId/name/width/height/mediaType，无内联
* 字节或 URL）。宿主 `resolveImageAttachmentAccess` 需要 AttachmentStore + 宿主路径
* 映射，二者均为宿主内部服务、不向 adapter 暴露——因此本模块把「ref → 图像来源」
* 定义为可注入的 `ImageAccessResolver`（生产侧由装配层桥接 resolveImageAttachmentAccess
* 的结果；缺省 undefined → 图像按宿主 textOnlyImageText 占位，绝不静默丢弃后发空请求）。
* 检测/投影一律复用宿主 re-export：contentHasImage / projectImagesForTextModel /
* offloadedImageText / textOnlyImageText（tasks 1.4 grep 自查：无自造等价物；
* 注：宿主 0.1.7-rc.2 无 `offloadRequestImagesWithPolicy` 导出，卸载决策由宿主
* 路由层负责，本插件只消费已带 `offloaded:true` 标记的块）。
* @module dsh-sensenova-provider/wire/blocks
*/
/** Responses input_image 协议格式集（文档 §Responses :3210 段，spec「图像限制校验」）。 */
const RESPONSES_IMAGE_FORMATS = /* @__PURE__ */ new Set([
	"png",
	"jpeg",
	"gif",
	"webp"
]);
/** deepseek-flash 图像限制（文档 :1468-1500；design 前提假设按 1024 进制）。 */
const DEEPSEEK_FLASH_IMAGE_LIMITS = {
	singleBytes: 52428800,
	totalBytes: 67108864,
	maxCount: 200
};
/** mediaType → 规范扩展名（jpg 与 jpeg 归一为 jpeg；白名单两侧同样归一）。 */
function formatOf(mediaType) {
	switch (mediaType) {
		case "image/png": return "png";
		case "image/jpg":
		case "image/jpeg": return "jpeg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		case "image/bmp": return "bmp";
		case "image/heic": return "heic";
		case "image/heif": return "heif";
		default: return;
	}
}
function refKey(ref) {
	return String(ref.attachmentId);
}
/** 是否为需要出站的图像块（offloaded 块由 builders 直接投影占位文本，不进本路径）。 */
function isLiveImage(block) {
	return block.type === "image" && block.offloaded !== true;
}
/**
* 出站前预解析全部图像块（唯一的异步步骤；builders 同步消费结果）：
* - 格式校验：mediaType → 扩展名后对照模型 imageFormats（Responses wire 再与
*   png/jpeg/gif/webp 求交）；不支持 → 报错（文案含支持列表，spec「格式不支持」）。
* - 限制校验：deepseek-flash 单图 50MB / 总 64MB / 200 张（spec「大小与数量超限」）；
*   「URL 总量 200MB」需要服务端字节信息，客户端无从测量，注记待实测（TODO）。
* - 编码：本地只读路径 → base64 data URL；URL 来源原样保留（kimi-k3 仅 base64：
*   URL 图像不进载荷表，builders 会以占位文本顶替并在此打日志，design 决策 3）。
* - 解析不到来源的图像同样不进载荷表（builders 投影 textOnlyImageText 占位）。
*
* @returns attachmentId → 载荷； builders 用 has() 区分「占位」与「直传」。
*/
async function prepareImages(options, entry, wire, resolveImageAccess) {
	const facts = factsFor(options.model, entry);
	const whitelist = new Set(facts.imageFormats.map((format) => format === "jpg" ? "jpeg" : format));
	if (wire === "responses") {
		for (const format of whitelist) if (!RESPONSES_IMAGE_FORMATS.has(format)) whitelist.delete(format);
	}
	const limits = options.model === "deepseek-flash" ? DEEPSEEK_FLASH_IMAGE_LIMITS : void 0;
	const prepared = /* @__PURE__ */ new Map();
	let count = 0;
	let totalBytes = 0;
	const seen = /* @__PURE__ */ new Set();
	for (const message of options.messages) for (const block of message.content) {
		if (!isLiveImage(block)) continue;
		count += 1;
		if (limits !== void 0 && count > limits.maxCount) throw new LlmError(`llm-sensenova: deepseek-flash 单请求最多 ${limits.maxCount} 张图片，当前 ${count} 张；请减少图片数量或换用其他模型`, "INVALID_REQUEST");
		const ref = block.attachment;
		const key = refKey(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		const format = formatOf(ref.mediaType);
		if (format === void 0 || !whitelist.has(format)) throw new LlmError(`llm-sensenova: 模型 ${options.model} 不支持图片格式 ${ref.mediaType ?? "(未知)"}${wire === "responses" ? "（Responses 协议）" : ""}；支持的格式：${[...whitelist].join(", ")}`, "INVALID_REQUEST");
		const access = resolveImageAccess?.(ref);
		if (access === void 0) continue;
		if ("url" in access) {
			if (facts.imageRequiresBase64) {
				console.warn(`[dsh-sensenova-provider] model ${options.model} accepts base64 images only; public-URL image ${JSON.stringify(ref.name ?? String(ref.attachmentId))} was replaced with a text placeholder`);
				continue;
			}
			prepared.set(key, {
				url: access.url,
				fromUrlSource: true
			});
			continue;
		}
		const bytes = await readFile(access.readonlyPath);
		const byteLength = access.byteLength ?? bytes.byteLength;
		if (limits !== void 0) {
			if (byteLength > limits.singleBytes) throw new LlmError(`llm-sensenova: deepseek-flash 单张图片不超过 50 MB（${(byteLength / 1024 / 1024).toFixed(1)} MB）；请压缩图片`, "INVALID_REQUEST");
			totalBytes += byteLength;
			if (totalBytes > limits.totalBytes) throw new LlmError("llm-sensenova: deepseek-flash 请求图片总量不超过 64 MB；请减少或压缩图片", "INVALID_REQUEST");
		}
		prepared.set(key, {
			url: `data:${ref.mediaType};base64,${bytes.toString("base64")}`,
			fromUrlSource: false
		});
	}
	return prepared;
}
/**
* 翻译一条 user 消息的 content（add-multimodal-input 1.2/1.3）：
* 无图像块 → 纯文本字符串（与迁移前出站完全一致，零回归）；
* 有图像块 → 按 wire 输出对象数组（kimi「content 必须是对象数组」同时满足）。
* offloaded 图像用宿主 offloadedImageText 投影；解析不到来源的图像用宿主
* textOnlyImageText 占位——两条路径都不再「静默丢弃」（P0-2）。
*/
function translateUserContent(content, wire, images) {
	if (!contentHasImage(content)) return content.filter((block) => block.type === "text").map((block) => block.text).join("");
	const items = [];
	for (const block of content) {
		if (block.type === "text") {
			items.push({
				type: wire === "responses" ? "input_text" : "text",
				text: block.text
			});
			continue;
		}
		if (block.type !== "image") continue;
		const ref = block.attachment;
		if (block.offloaded === true) {
			items.push({
				type: wire === "responses" ? "input_text" : "text",
				text: offloadedImageText(ref)
			});
			continue;
		}
		const prepared = images?.get(refKey(ref));
		if (prepared === void 0) {
			items.push({
				type: wire === "responses" ? "input_text" : "text",
				text: textOnlyImageText(ref)
			});
			continue;
		}
		if (wire === "responses") items.push({
			type: "input_image",
			image_url: prepared.url
		});
		else items.push({
			type: "image_url",
			image_url: { url: prepared.url }
		});
	}
	return items;
}
//#endregion
//#region src/wire/body-chat.ts
/** 展平工具结果内容块为纯文本（0.1.7 类型面：tool 结果为独立 role:'tool' 消息）。 */
function toolResultText$1(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : "").join("");
}
/** 拼出某条消息的可见文本（接受 RequestMessage：含无持久 id 的 RequestUserInput）。 */
function flattenText$1(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** 把 OpenAI 消息历史翻译为 OpenAI 请求体消息数组。
* replayReasoning（deepseek 系且本轮带 tools）：把宿主历史 assistant 消息里的
* reasoning 増量重建为 assistant 项的 reasoning_content 回传（文档 :1411-1412、
* :1790-1791：deepseek 系带 tools 必须回传全部历史思维链；不带 tools 或其余模型
* 不携带——6.8/glm 多轮不回传，kimi 仅要求原样回传 content+tool_calls）。 */
function toOpenAiMessages(options, replayReasoning, images) {
	const systemParts = [];
	if (options.system !== void 0 && options.system !== "") systemParts.push(options.system);
	for (const message of options.messages) if (message.role === "system") systemParts.push(flattenText$1(message));
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
			const text = flattenText$1(message);
			const reasoningText = replayReasoning ? message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("") : "";
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
			if (reasoningText !== "") entry.reasoning_content = reasoningText;
			if (sanitizedCalls.length > 0) entry.tool_calls = sanitizedCalls;
			messages.push(entry);
			continue;
		}
		if (message.role === "tool") {
			const remappedId = toolCallIdRemap.get(message.toolCallId);
			if (remappedId === void 0) continue;
			messages.push({
				role: "tool",
				tool_call_id: remappedId,
				content: toolResultText$1(message.content) || "(no output)"
			});
			continue;
		}
		const content = translateUserContent(message.content, "chat-completions", images);
		if (typeof content === "string") {
			if (content !== "") messages.push({
				role: "user",
				content
			});
		} else if (content.length > 0) messages.push({
			role: "user",
			content
		});
	}
	return messages;
}
/** 计算模型的 Chat 字段分派计划（add-model-facts 2.2：数据驱动自 wire/facts，
* 出站行为与迁移前逐字段一致；未知模型沿用「保守不发/原样 effort」语义）。 */
function chatFieldPlan(model, entry) {
	const facts = factsFor(model, entry);
	const catalogEfforts = entry?.reasoning?.efforts.map((effort) => effort.id);
	const staticDomain = facts.efforts.length > 0 ? facts.efforts : void 0;
	return {
		maxTokensField: facts.outputLimitField,
		streamOptionsUsage: facts.supportsStreamOptions,
		replayReasoningWithTools: facts.requiresReasoningReplay,
		blockedSampling: new Set(facts.blockedSampling),
		effortCompat: facts.effortCompat,
		effortDomain: catalogEfforts ?? staticDomain,
		noneMapsToThinkingDisabled: facts.noneMapsToThinkingDisabled
	};
}
/** 组装 OpenAI /chat/completions 请求体（按 ChatFieldPlan 分派字段）。
* images：blocks.ts 预解析的图像载荷（add-multimodal-input）；缺省 undefined 时
* user 内容保持纯文本现状（零回归）。 */
function buildChatBody(options, entry, images) {
	const model = options.model;
	const plan = chatFieldPlan(model, entry);
	const tools = (options.tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	const messages = toOpenAiMessages(options, plan.replayReasoningWithTools && tools.length > 0, images);
	const samplingWhitelist = entry?.supportedSamplingParameters ?? staticFacts(model)?.samplingParameters;
	const samplingAllowed = (field, blocked) => {
		if (blocked) return false;
		if (samplingWhitelist === void 0) return true;
		return samplingWhitelist.includes(field);
	};
	let reasoningEffortWire;
	let thinkingDisabled = false;
	if (options.reasoningEffort !== void 0) {
		const effort = options.reasoningEffort;
		if (plan.noneMapsToThinkingDisabled && effort === "none") thinkingDisabled = true;
		else {
			const mapped = plan.effortCompat?.[effort];
			const inDomain = plan.effortDomain?.includes(effort) ?? true;
			reasoningEffortWire = mapped !== void 0 ? mapped : inDomain ? effort : void 0;
		}
	}
	return {
		model,
		messages,
		stream: true,
		...options.temperature !== void 0 && samplingAllowed("temperature", plan.blockedSampling.has("temperature")) ? { temperature: options.temperature } : {},
		...options.maxTokens !== void 0 ? { [plan.maxTokensField]: options.maxTokens } : {},
		...options.stop !== void 0 && options.stop.length > 0 ? { stop: options.stop } : {},
		...tools.length > 0 ? { tools } : {},
		...plan.streamOptionsUsage ? { stream_options: { include_usage: true } } : {},
		...reasoningEffortWire !== void 0 ? { reasoning_effort: reasoningEffortWire } : {},
		...thinkingDisabled ? { thinking: "disabled" } : {}
	};
}
//#endregion
//#region src/wire/body-responses.ts
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function toolResultText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : "").join("");
}
/**
* 把宿主消息历史映射为 Responses input 数组（§6.5）：
* - system 消息与 options.system 合并为顶层 instructions；
* - user 文本 → {role:'user',content:[{type:'input_text',text}]}；
* - assistant 文本 → {role:'assistant',content:[{type:'output_text',text}]}；
* - assistant tool-call → {type:'function_call',call_id,name,arguments}；
* - tool-result → {type:'function_call_output',call_id,output}。
*
* 坏历史 tool_call 四防御与 Chat 路径一致（tasks 2.1）：空 name 丢弃（含孤立
* tool-result）、arguments 空串补 '{}'、id 空串合成 sensenova-sanitized-N、
* 映射不到 call_id 的 tool-result 丢弃。
*/
function toResponsesInput(options, images) {
	const systemParts = [];
	if (options.system !== void 0 && options.system !== "") systemParts.push(options.system);
	for (const message of options.messages) if (message.role === "system") systemParts.push(flattenText(message));
	const instructions = systemParts.filter(Boolean).join("\n\n");
	const input = [];
	const toolCallIdRemap = /* @__PURE__ */ new Map();
	let syntheticToolCallSeq = 0;
	for (const message of options.messages) {
		if (message.role === "system") continue;
		if (message.role === "assistant") {
			const text = flattenText(message);
			const toolCalls = message.content.filter((block) => block.type === "tool-call");
			let emitted = false;
			for (const call of toolCalls) {
				if (call.name === "" || call.name === void 0) continue;
				syntheticToolCallSeq += 1;
				const keptId = call.id !== "" && call.id !== void 0 ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
				toolCallIdRemap.set(call.id, keptId);
				input.push({
					type: "function_call",
					call_id: keptId,
					name: call.name,
					arguments: call.arguments !== "" && call.arguments !== void 0 ? call.arguments : "{}"
				});
				emitted = true;
			}
			if (text !== "") {
				input.push({
					role: "assistant",
					content: [{
						type: "output_text",
						text
					}]
				});
				emitted = true;
			}
			if (!emitted) continue;
			continue;
		}
		if (message.role === "tool") {
			const remappedId = toolCallIdRemap.get(message.toolCallId);
			if (remappedId === void 0) continue;
			input.push({
				type: "function_call_output",
				call_id: remappedId,
				output: toolResultText(message.content) || "(no output)"
			});
			continue;
		}
		const content = translateUserContent(message.content, "responses", images);
		if (typeof content === "string") {
			if (content !== "") input.push({
				role: "user",
				content: [{
					type: "input_text",
					text: content
				}]
			});
		} else if (content.length > 0) input.push({
			role: "user",
			content
		});
	}
	return {
		instructions: instructions !== "" ? instructions : void 0,
		input
	};
}
/**
* 组装 /responses 请求体。max_output_tokens 按 responsesMaxOutputTokens 钳制
* （含推理 token；上限缺失回退 Chat 档 outputLimitMax，deepseek-flash 文档未列
* responses 上限 = null，保守回退待实测）。
*/
function buildResponsesBody(options, entry, config = {}, images) {
	const model = options.model;
	const facts = factsFor(model, entry);
	const outputLimit = facts.responsesMaxOutputTokens ?? facts.outputLimitMax;
	const { instructions, input } = toResponsesInput(options, images);
	const tools = (options.tools ?? []).map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	const sendTemperature = options.temperature !== void 0 && !facts.blockedSampling.includes("temperature");
	const reasoning = options.reasoningEffort === "none" ? {
		effort: "none",
		summary: config.reasoningSummary ?? "auto"
	} : void 0;
	return {
		model,
		input,
		stream: true,
		...instructions !== void 0 ? { instructions } : {},
		...sendTemperature ? { temperature: options.temperature } : {},
		...options.maxTokens !== void 0 && outputLimit !== null ? { max_output_tokens: Math.min(options.maxTokens, outputLimit) } : options.maxTokens !== void 0 ? { max_output_tokens: options.maxTokens } : {},
		...tools.length > 0 ? { tools } : {},
		...reasoning !== void 0 ? { reasoning } : {}
	};
}
//#endregion
//#region src/wire/usage.ts
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toNumber$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** 把 Responses 事件携带的 usage 对象映射为宿主 TokenUsage。 */
function mapResponsesUsage(usage) {
	const input = toNumber$1(usage.input_tokens);
	const output = toNumber$1(usage.output_tokens);
	const total = toNumber$1(usage.total_tokens);
	const inputDetails = isRecord$2(usage.input_tokens_details) ? usage.input_tokens_details : void 0;
	const outputDetails = isRecord$2(usage.output_tokens_details) ? usage.output_tokens_details : void 0;
	const cacheRead = inputDetails !== void 0 ? toNumber$1(inputDetails.cached_tokens) : 0;
	const reasoning = outputDetails !== void 0 ? toNumber$1(outputDetails.reasoning_tokens) : 0;
	return {
		inputTokens: input,
		outputTokens: output,
		totalTokens: total > 0 ? total : input + output,
		...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning > 0 ? { reasoningTokens: reasoning } : {}
	};
}
//#endregion
//#region src/wire/sse-responses.ts
/** Responses SSE → 宿主 StreamChunk 翻译（make-responses-default-wire-protocol 3.x；
* docs/sensenova-upgrade-plan.md §6.6）。
*
* 事件映射：output_item.added → block-start（output_index 即 block index；
* item.type reasoning/message/function_call → 推理/文本/工具块）；
* reasoning_summary_text.delta → reasoning-delta；output_text.delta → text-delta；
* function_call_arguments.delta → tool-call-delta（call_id 即 ToolCallId）；
* output_item.done → block-end；response.completed / incomplete / failed 收尾
* （不等待也不识别 [DONE]）。并行 function_call 按 output_index 分桶拼接。
* 不依赖 sequence_number（design §八·14 假设 6）。
* @module dsh-sensenova-provider/wire/sse-responses
*/
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toString$1(value) {
	return typeof value === "string" ? value : void 0;
}
/** 解析一行 SSE；返回 [事件类型, 事件对象]；[DONE]/空行/注释行/无 type 返回 undefined。 */
function parseResponsesLine(line) {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":")) return void 0;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return void 0;
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (!isRecord$1(parsed)) return void 0;
	const type = toString$1(parsed.type);
	if (type === void 0) return void 0;
	return {
		type,
		event: parsed
	};
}
/** output_item.added 的 item.type → 宿主块类型。 */
function blockTypeForItem(itemType) {
	if (itemType === "message") return "text";
	if (itemType === "reasoning") return "reasoning";
	if (itemType === "function_call") return "tool-call";
}
function closeItem(index, item) {
	if (item === void 0) return [];
	if (item.blockType === "tool-call") {
		const name = item.name ?? "";
		if (name === "") return [];
		return [{
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id: ToolCallId(item.callId ?? `sensenova-tool-${index}`),
				name,
				arguments: item.content !== "" ? item.content : "{}"
			}
		}];
	}
	return [{
		type: "block-end",
		index,
		block: item.blockType === "text" ? {
			type: "text",
			text: item.content
		} : {
			type: "reasoning",
			text: item.content
		}
	}];
}
function closeAllOpen(state) {
	const chunks = [];
	for (const [index, item] of [...state.open.entries()]) chunks.push(...closeItem(index, item));
	state.open.clear();
	state.indexByItemId.clear();
	return chunks;
}
/** 处理一个 Responses 事件，返回宿主 StreamChunk 序列（无终止语义）。 */
function processResponsesEvent(parsed, state) {
	const { type, event } = parsed;
	const chunks = [];
	if (type === "response.output_item.added") {
		const item = isRecord$1(event.item) ? event.item : void 0;
		const blockType = blockTypeForItem(toString$1(item?.type) ?? "");
		if (blockType !== void 0 && typeof event.output_index === "number") {
			const index = event.output_index;
			state.open.set(index, {
				blockType,
				content: "",
				callId: toString$1(item?.call_id),
				name: toString$1(item?.name)
			});
			const itemId = toString$1(event.item_id);
			if (itemId !== void 0) state.indexByItemId.set(itemId, index);
			if (blockType === "tool-call") state.sawContent = true;
			chunks.push({
				type: "block-start",
				index,
				blockType
			});
		}
		return chunks;
	}
	const resolveIndex = (ev) => {
		if (typeof ev.output_index === "number" && state.open.has(ev.output_index)) return ev.output_index;
		const itemId = toString$1(ev.item_id);
		const mapped = itemId !== void 0 ? state.indexByItemId.get(itemId) : void 0;
		if (mapped !== void 0 && state.open.has(mapped)) return mapped;
	};
	const deltaText = (ev) => toString$1(ev.delta) ?? "";
	if (type === "response.output_text.delta") {
		const index = resolveIndex(event);
		if (index === void 0) return chunks;
		const item = state.open.get(index);
		if (item !== void 0 && item.blockType === "text") {
			const delta = deltaText(event);
			item.content += delta;
			state.sawContent = true;
			chunks.push({
				type: "text-delta",
				index,
				text: delta
			});
		}
		return chunks;
	}
	if (type === "response.reasoning_summary_text.delta") {
		const index = resolveIndex(event);
		if (index === void 0) return chunks;
		const item = state.open.get(index);
		if (item !== void 0 && item.blockType === "reasoning") {
			const delta = deltaText(event);
			item.content += delta;
			state.sawContent = true;
			chunks.push({
				type: "reasoning-delta",
				index,
				text: delta
			});
		}
		return chunks;
	}
	if (type === "response.function_call_arguments.delta") {
		const index = resolveIndex(event);
		if (index === void 0) return chunks;
		const item = state.open.get(index);
		if (item !== void 0 && item.blockType === "tool-call") {
			const delta = deltaText(event);
			item.content += delta;
			chunks.push({
				type: "tool-call-delta",
				index,
				id: ToolCallId(item.callId ?? `sensenova-tool-${index}`),
				...item.name !== void 0 && item.name !== "" ? { name: item.name } : {},
				argumentsDelta: delta
			});
		}
		return chunks;
	}
	if (type === "response.output_item.done") {
		const index = typeof event.output_index === "number" ? event.output_index : void 0;
		const item = index !== void 0 ? state.open.get(index) : void 0;
		if (index !== void 0 && item !== void 0) {
			const doneItem = isRecord$1(event.item) ? event.item : void 0;
			if (item.callId === void 0) item.callId = toString$1(doneItem?.call_id);
			if (item.name === void 0 || item.name === "") item.name = toString$1(doneItem?.name);
			state.open.delete(index);
			const itemId = toString$1(event.item_id);
			if (itemId !== void 0) state.indexByItemId.delete(itemId);
			chunks.push(...closeItem(index, item));
		}
		return chunks;
	}
	return chunks;
}
/** 终止族事件 → 收尾 chunk 序列（close + usage + finish）。 */
function finishFromTerminalEvent(parsed, state) {
	const { type, event } = parsed;
	const chunks = closeAllOpen(state);
	const response = isRecord$1(event.response) ? event.response : void 0;
	const usageRec = isRecord$1(response?.usage) ? response?.usage : void 0;
	if (usageRec !== void 0) chunks.push({
		type: "usage",
		usage: mapResponsesUsage(usageRec)
	});
	let reason;
	if (type === "response.completed") reason = (Array.isArray(response?.output) ? response.output : []).some((item) => isRecord$1(item) && toString$1(item.type) === "function_call") ? { kind: "tool-calls" } : { kind: "stop" };
	else if (type === "response.incomplete") {
		const incompleteReason = toString$1((isRecord$1(response?.incomplete_details) ? response?.incomplete_details : void 0)?.reason);
		if (incompleteReason === "max_output_tokens") reason = { kind: "max-tokens" };
		else reason = {
			kind: "error",
			failure: {
				message: `SenseNova response incomplete: ${incompleteReason ?? "unknown reason"}`,
				code: "PROVIDER_PROTOCOL_ERROR"
			}
		};
	} else reason = {
		kind: "error",
		failure: {
			message: toString$1((isRecord$1(event.error) ? event.error : isRecord$1(response?.error) ? response?.error : void 0)?.message) ?? "SenseNova response failed",
			code: "PROVIDER_PROTOCOL_ERROR"
		}
	};
	chunks.push({
		type: "finish",
		reason
	});
	return chunks;
}
function isTerminalType(type) {
	return type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error";
}
/** 判断错误是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason$1(value) {
	return value instanceof Error && value.name === "TimeoutError";
}
/** 把 Responses SSE 响应体翻译为宿主 StreamChunk 序列（结构与 parseOpenAiSse 对齐：
* 空闲看门狗、断尾收口、错误映射）。 */
async function* parseResponsesSse(body, signal, idleTimeoutMs) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state = {
		open: /* @__PURE__ */ new Map(),
		indexByItemId: /* @__PURE__ */ new Map(),
		sawContent: false,
		finished: false
	};
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
				const parsed = parseResponsesLine(line);
				if (parsed === void 0) continue;
				if (finished) continue;
				if (isTerminalType(parsed.type)) {
					for (const chunk of finishFromTerminalEvent(parsed, state)) {
						yield chunk;
						if (chunk.type === "finish") finished = true;
					}
					continue;
				}
				for (const chunk of processResponsesEvent(parsed, state)) yield chunk;
			}
		}
		if (buffer.trim() !== "") {
			const parsed = parseResponsesLine(buffer);
			if (parsed !== void 0 && !finished) {
				if (isTerminalType(parsed.type)) for (const chunk of finishFromTerminalEvent(parsed, state)) {
					yield chunk;
					if (chunk.type === "finish") finished = true;
				}
				else for (const chunk of processResponsesEvent(parsed, state)) yield chunk;
			}
		}
		if (!finished) {
			for (const chunk of closeAllOpen(state)) yield chunk;
			if (!state.sawContent) throw new LlmError("llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复", "EMPTY_RESPONSE");
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		}
	} catch (error) {
		if (signal?.aborted && isTimeoutReason$1(signal.reason) || isTimeoutReason$1(error)) throw new LlmError(`llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`, "TIMEOUT", { cause: error });
		if (signal?.aborted || error instanceof LlmError) throw error;
		throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, "TRANSPORT", { cause: error });
	} finally {
		disarmWatchdog();
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
//#endregion
//#region src/wire/plan.ts
/** wire 协议决策（make-responses-default-wire-protocol；docs/sensenova-upgrade-plan.md §五）。
*
* §5.2 判定表四条降级 + 「省略优于传无效值」：
* - stop 非空 / 模型不支持 Responses / effort 偏离 Responses 默认档（非 none）/
*   运行时 400 标记（§5.3 responsesUnsupported）→ 降级 Chat Completions。
* - effort === none → Responses 显式发 reasoning:{effort:"none"}（真关闭）。
* - effort === responsesDefaultEffort 或未选 → Responses 不发 reasoning（默认即所需）。
* - `responses` 强制模式命中任一降级条件 → 抛错并说明切换方法（不静默回退）。
* @module dsh-sensenova-provider/wire/plan
*/
/** 命中降级时的判定（未命中为 undefined）。 */
function degradeReason(options, facts, responsesUnsupported) {
	if (options.stop !== void 0 && options.stop.length > 0) return "downgrade-stop";
	if (!facts.supportedWires.includes("responses")) return "downgrade-unsupported-model";
	const effort = options.reasoningEffort;
	if (effort !== void 0 && effort !== "none" && effort !== facts.responsesDefaultEffort) return "downgrade-effort";
	if (responsesUnsupported.has(options.model)) return "downgrade-runtime-marked";
}
/**
* 决定本次请求使用的 wire（§5.2 四条降级判定，序即优先级）。
* `responses` 强制模式命中降级条件时抛 LlmError，消息说明如何切换到 auto 或
* chat-completions（spec「强制 Responses 报错」场景）。
*/
function resolveWirePlan(options, config, facts, responsesUnsupported) {
	const protocol = config.wireProtocol ?? "auto";
	if (protocol === "chat-completions") return {
		wire: "chat-completions",
		reason: "forced-chat"
	};
	const degrade = degradeReason(options, facts, responsesUnsupported);
	if (degrade !== void 0) {
		if (protocol === "responses") throw new LlmError(`llm-sensenova: wireProtocol "responses" cannot serve this request (${degrade})；当前请求在强制 Responses 模式下无法保真（${degrade}），请在设置中将 wireProtocol 切换为 "auto"（自动降级 Chat Completions）或 "chat-completions"`, "INVALID_REQUEST");
		return {
			wire: "chat-completions",
			reason: degrade
		};
	}
	return {
		wire: "responses",
		reason: protocol === "responses" ? "forced-responses" : "responses-default"
	};
}
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
/** 官方文档声明的模型族事实已迁入 src/wire/facts.ts（add-model-facts 2.2）；
* adapter 仅消费 factsFor/staticFacts，不复制第二份。 */
/** Chat 请求体构造已迁出至 wire/body-chat.ts（make-responses-default-wire-protocol 4.1，行为不变）。 */
/**
* SenseNova 目录通常不披露上下文字段，这里用 131072 作为合理默认
* （DeepSeek 系列与 SenseNova 常见模型窗口）；目录有字段时优先采用。
*/
const DEFAULT_CONTEXT_WINDOW = 131072;
const MODELS_TIMEOUT_MS = 1e4;
/**
* 目录缓存 TTL（毫秒）：宿主（模型选择器/策略 UI）会以秒级周期反复调用
* listModels()（2026-10-10 Loon 实测 ~5s 一次），而模型目录变化极慢。
* 缓存命中期间从内存应答，不发 HTTP；用户明确「一天一次够用」。
*/
const CATALOG_TTL_MS = 864e5;
/** 目录刷新失败后的退避（毫秒）：防止故障时退化为秒级重试循环。 */
const CATALOG_FAILURE_RETRY_MS = 6e4;
/**
* 提交给 provider 重试层的延迟上限（毫秒）：本地退避与非配额 429 的
* Retry-After 均受此约束，同时作为重试策略退避单次上限。
* fix-sensenova-429-quota-retry（2026-09-04 实测）：原 3000ms 与配额窗口量级
* 不符——TPM 为 60 秒窗口，提升到 60000ms（spec 允许区间 60–120s 的下沿）。
*/
const PROVIDER_RETRY_AFTER_CAP_MS = 6e4;
/** 配额类 429 退避指导（providerRetryAfterMs）的绝对上限（毫秒）：与
* PROVIDER_RETRY_AFTER_CAP_MS（即重试策略单次延迟上限）一致。宿主 dsh-llm-retry
* （normal 模式）在 providerRetryAfterMs 超过单次延迟上限时会直接放弃重试，封顶
* 对齐后保证任何采用值都会被宿主按指导延迟重试；不影响 TPM 分级档（3–15s）与
* code 8 固定档（15s）的正常取值。 */
const QUOTA_RETRY_AFTER_CEILING_MS = 6e4;
/** 配额类 429（code 8，rps/rpm exhausted）退避下限（毫秒）。2026-09-04 实测：速率桶补充 ≈1 个/14s，15s 覆盖一个完整补充周期。 */
const QUOTA_RATE_RETRY_FLOOR_MS = 15e3;
/** 已知不可路由的模型 id 清单（已下线路由，调用返回 404）。 */
const KNOWN_UNROUTABLE_MODELS = /* @__PURE__ */ new Set(["sensenova-6.7-flash-lite"]);
/** 明确的模型不可用错误码（不在默认可重试集合内，故不触发 provider 重试）。 */
const MODEL_NOT_FOUND_CODE = "MODEL_NOT_FOUND";
/** 模型 id → 标准显示名的显式品牌映射。 */
const DISPLAY_NAME_OVERRIDES = /* @__PURE__ */ new Map([["sensenova-6.7-flash-lite", "Sensenova 6.7 Flash Lite"]]);
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
/** 读取目录 supported_sampling_parameters 白名单；缺失返回 undefined。 */
function samplingListField(raw) {
	const value = raw.supported_sampling_parameters;
	if (!Array.isArray(value)) return void 0;
	const list = value.filter((item) => typeof item === "string" && item !== "");
	return list.length > 0 ? list : void 0;
}
/** 目录未返回 supported_sampling_parameters 时的静态兜底已迁入 src/wire/facts.ts
* （静态档案 samplingParameters 字段；kimi-k3 依文档 :2455-2457 补 seed/parallel_tool_calls）。 */
/** 解析目录条目的 reasoning 词表；目录词表优先，静态表仅补全已知且有支持标记的模型。
* defaultEffort：目录声明的默认档优先；目录未带（或命中静态表）时回退静态表默认档
* （align-request-fields-with-docs 1.2：命中静态表即声明 defaultEffort）。 */
function reasoningInfoFrom(raw, modelId) {
	const efforts = effortListField(raw) ?? nestedEffortListField(raw);
	const knownFacts = staticFacts(modelId);
	const selectedEfforts = efforts ?? (knownFacts !== void 0 && hasReasoningSupport(raw) ? knownFacts.efforts : void 0);
	if (selectedEfforts === void 0 || selectedEfforts.length === 0) return void 0;
	const infos = selectedEfforts.map((effort) => ({
		id: ReasoningEffortId(effort),
		name: effort
	}));
	const declaredDefault = efforts !== void 0 ? defaultEffortField(raw) : void 0;
	const fallbackDefault = knownFacts?.defaultEffort ?? void 0;
	const defaultEffort = declaredDefault ?? fallbackDefault;
	const defaultId = defaultEffort !== void 0 && selectedEfforts.includes(defaultEffort) ? ReasoningEffortId(defaultEffort) : void 0;
	return {
		efforts: infos,
		...defaultId !== void 0 ? { defaultEffort: defaultId } : {}
	};
}
/** 解析 OpenAI 模型目录为目录条目；应用自动过滤与失败缓存。 */
function parseCatalog(value, failedModels) {
	if (!isRecord(value) || !Array.isArray(value.data)) throw new LlmError("llm-sensenova: unexpected models response shape", "PROVIDER_PROTOCOL_ERROR");
	const out = [];
	for (const raw of value.data) {
		if (!isRecord(raw)) continue;
		const id = toString(raw.id);
		if (id === void 0 || id === "") continue;
		const output = raw.output_modalities;
		if (!(Array.isArray(output) ? output.some((item) => toString(item) === "text") : false)) continue;
		if (KNOWN_UNROUTABLE_MODELS.has(id)) continue;
		if (failedModels.has(id)) continue;
		const contextWindow = firstContextField(raw);
		const maxOutputTokens = firstMaxOutputField(raw);
		const reasoning = reasoningInfoFrom(raw, id);
		const supportedSamplingParameters = samplingListField(raw);
		out.push({
			id,
			name: displayNameFor(id),
			inputModalities: inputModalitiesFrom(raw),
			...contextWindow !== void 0 ? { contextWindow } : {},
			...maxOutputTokens !== void 0 ? { maxOutputTokens } : {},
			...reasoning !== void 0 ? { reasoning } : {},
			...supportedSamplingParameters !== void 0 ? { supportedSamplingParameters } : {}
		});
	}
	return out;
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
/** §5.3：400 响应体是否为 error.type === 'invalid_request_error'（Responses 运行时不符信号）。 */
function isInvalidRequestError(errText) {
	try {
		const parsed = JSON.parse(errText);
		return isRecord(parsed) && isRecord(parsed.error) && parsed.error.type === "invalid_request_error";
	} catch {
		return false;
	}
}
/** 是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason(value) {
	return value instanceof Error && value.name === "TimeoutError";
}
/**
* 429001 分级探测退避档位（毫秒）——2026-09-04 定稿：不设长固定下限（60s/180s 均会
* 把用户干锁在死等里），而是每次宿主重试各自重新探测，等待随连续 429001 次数递增
* 3s → 5s → 10s → 15s 后封顶（每轮重置、不继承：任一成功即清零，恢复后立即回到 3s）。
* 官方文档将 429 统一标注为 quota_exceeded_error 且建议「指数退避重试」，未公开数值；
* 实测 key A 30k 请求 429001、key B 同刻通过 → per-key 限速差异，短探测 + 换 key 优先。
*/
const TPM_PROBE_BACKOFF_STEPS_MS = [
	3e3,
	5e3,
	1e4,
	15e3
];
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
			retryFloorMs: void 0,
			kind: void 0
		};
	}
	if (!isRecord(parsed) || !isRecord(parsed.error)) return {
		quota: false,
		retryFloorMs: void 0,
		kind: void 0
	};
	const code = parsed.error.code;
	if (typeof code !== "number" && typeof code !== "string") return {
		quota: false,
		retryFloorMs: void 0,
		kind: void 0
	};
	if (code === 8 || code === "8") return {
		quota: true,
		retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS,
		kind: "rate"
	};
	if (code === 429001 || code === "429001") return {
		quota: true,
		retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0],
		kind: "tpm"
	};
	return {
		quota: false,
		retryFloorMs: void 0,
		kind: void 0
	};
}
/** 把预流 HTTP 失败映射为稳定 LlmError。
* dynamicFloorMs：stream 层算好的配额类动态退避下限（429001 分级探测），
* 覆盖 classify429Body 返回的静态 floor；undefined 时用静态 floor。 */
function httpError(status, errText, retryAfterMs, dynamicFloorMs) {
	if (status === 401) return new LlmError("llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效", "INVALID_CREDENTIAL", { status: 401 });
	if (status === 404 && isModelNotFoundText(errText)) return new LlmError("llm-sensenova: SenseNova model is not routable — the model id is no longer served；SenseNova 模型不可路由：该模型 id 已下线", MODEL_NOT_FOUND_CODE, { status: 404 });
	if (status === 429) {
		const classified = classify429Body(errText);
		const floorMs = dynamicFloorMs ?? classified.retryFloorMs;
		let providerRetryAfterMs;
		if (floorMs !== void 0) providerRetryAfterMs = Math.min(Math.max(floorMs, retryAfterMs !== void 0 && retryAfterMs > 0 ? retryAfterMs : 0), QUOTA_RETRY_AFTER_CEILING_MS);
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
	/** 进程内失败缓存：运行时返回 MODEL_NOT_FOUND 的模型 id。 */
	failedModels = /* @__PURE__ */ new Set();
	/** §5.3 运行时不符兜底：Responses 400 invalid_request_error 的模型 id（进程内，
	* 不持久化；命中后 resolveWirePlan 第 4 条判定直接降级 Chat）。 */
	responsesUnsupported = /* @__PURE__ */ new Set();
	/** 上一次成功目录请求使用的 key/base；变化时旧失败缓存不再可信。 */
	catalogCredential;
	catalogApiBase;
	/** 目录缓存时间戳（毫秒 epoch）；与 TTL 共同决定下次调用是否实发 HTTP。 */
	catalogFetchedAt = 0;
	/** 目录刷新失败后的下次重试时间（毫秒 epoch）；仅失败时写入。 */
	catalogNextRetryAt = 0;
	/** 目录单飞去重：并发的 listModels 共享同一 in-flight Promise。 */
	catalogInflight;
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
	* 429001 连续命中计数（per-session，分级探测用）：命中 +1、成功/换 key 清零，
	* 决定下次探测档位 TPM_PROBE_BACKOFF_STEPS_MS[count]。仅内存，随适配器生命周期。
	*/
	tpmHitCounts = /* @__PURE__ */ new Map();
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
			maxRetries: 100,
			backoff: { maxDelayMs: PROVIDER_RETRY_AFTER_CAP_MS }
		}, "llm-sensenova.retryPolicy");
	}
	async listModels(provider) {
		return (await this.fetchCatalog()).map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			inputModalities: model.inputModalities
		}));
	}
	/**
	* 目录获取入口（listModels 专用）：TTL 内从缓存应答，过期后单飞实发 HTTP。
	* 成功刷新 TTL=CATALOG_TTL_MS（24h）；失败退避 CATALOG_FAILURE_RETRY_MS（60s）
	* 并维持旧缓存可读，避免宿主秒级问询在故障时退化为秒级重试循环。
	* 凭据或 apiBase 变化立即失效（换 key/换端点后旧目录不再可信）。
	*/
	async fetchCatalog() {
		const connection = this.deps.options();
		let apiKey;
		try {
			apiKey = await this.deps.resolveApiKey(connection);
		} catch (error) {
			if (error instanceof LlmError && error.code === "MISSING_CREDENTIAL") return [];
			throw error;
		}
		const now = Date.now();
		const credentialChanged = this.catalogCredential !== void 0 && this.catalogCredential !== apiKey;
		const apiBaseChanged = this.catalogApiBase !== void 0 && this.catalogApiBase !== connection.apiBase;
		if (!credentialChanged && !apiBaseChanged && this.catalogFetchedAt > 0 && now - this.catalogFetchedAt < CATALOG_TTL_MS) return this.catalog;
		if (this.catalogNextRetryAt > now) return this.catalog;
		if (this.catalogInflight !== void 0) return this.catalogInflight;
		const inflight = this.fetchCatalogUncached(connection, apiKey, credentialChanged || apiBaseChanged);
		this.catalogInflight = inflight;
		inflight.then(() => {
			this.catalogInflight = void 0;
		}, () => {
			this.catalogInflight = void 0;
			this.catalogNextRetryAt = Date.now() + CATALOG_FAILURE_RETRY_MS;
		});
		return inflight;
	}
	/** 实际发起 HTTP 目录请求并更新缓存（仅 fetchCatalog 调用）。 */
	async fetchCatalogUncached(connection, apiKey, invalidateFailedModels) {
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
		const parsed = await response.json();
		if (invalidateFailedModels) this.failedModels.clear();
		const models = parseCatalog(parsed, this.failedModels);
		this.catalogCredential = apiKey;
		this.catalogApiBase = connection.apiBase;
		this.catalogFetchedAt = Date.now();
		this.catalog = models;
		return models;
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
		const entry = this.catalog.find((m) => m.id === options.model);
		const facts = factsFor(options.model, entry);
		let wire = resolveWirePlan(options, connection, facts, this.responsesUnsupported).wire;
		const projectedMessages = facts.supportsImages ? options.messages : projectImagesForTextModel(options.messages);
		const request = projectedMessages === options.messages ? options : {
			...options,
			messages: [...projectedMessages]
		};
		const imagePayloads = /* @__PURE__ */ new Map();
		const payloadsFor = async (w) => {
			let payloads = imagePayloads.get(w);
			if (payloads === void 0) {
				payloads = await prepareImages(request, entry, w, this.deps.resolveImageAccess);
				imagePayloads.set(w, payloads);
			}
			return payloads;
		};
		const buildBody = async (w) => JSON.stringify(w === "responses" ? buildResponsesBody(request, entry, { reasoningSummary: connection.reasoningSummary }, await payloadsFor(w)) : buildChatBody(request, entry, await payloadsFor(w)));
		let body = await buildBody(wire);
		let responsesFallbackUsed = false;
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
					attempt = await this.fetchImpl(`${connection.apiBase}${wire === "responses" ? "/responses" : "/chat/completions"}`, {
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
					this.tpmHitCounts.delete(options.sessionId);
					break;
				}
				const errText = await attempt.text().catch(() => "");
				const retryAfterMs = parseRetryAfterMs(attempt.headers.get("retry-after"));
				if (attempt.status === 400 && wire === "responses" && !responsesFallbackUsed && isInvalidRequestError(errText)) {
					this.responsesUnsupported.add(options.model);
					console.warn(`[dsh-sensenova-provider] responses wire rejected model "${options.model}" with 400 invalid_request_error; falling back to chat-completions for this and subsequent requests in this process`);
					wire = "chat-completions";
					body = await buildBody(wire);
					responsesFallbackUsed = true;
					release();
					release = void 0;
					continue;
				}
				if (attempt.status === 404 && isModelNotFoundText(errText)) {
					release();
					release = void 0;
					this.failedModels.add(options.model);
					this.catalogFetchedAt = 0;
					throw httpError(attempt.status, errText, retryAfterMs);
				}
				const classified = classify429Body(errText);
				const quota429 = attempt.status === 429 && classified.quota;
				let dynamicFloorMs;
				if (classified.kind === "tpm") {
					const hits = this.tpmHitCounts.get(options.sessionId) ?? 0;
					dynamicFloorMs = TPM_PROBE_BACKOFF_STEPS_MS[Math.min(hits, TPM_PROBE_BACKOFF_STEPS_MS.length - 1)];
					this.tpmHitCounts.set(options.sessionId, hits + 1);
				}
				const quotaRotate = quota429 && quotaRotation;
				if ((attempt.status === 401 || quotaRotate) && options.signal?.aborted !== true && rotations < connection.accountCount) {
					const next = await this.deps.rotateApiKey(apiKey, attempt.status === 401 ? "invalid-credential" : "quota-exhausted");
					if (next !== void 0 && !tried.has(next)) {
						release();
						release = void 0;
						apiKey = next;
						rotations += 1;
						if (quotaRotate) {
							this.quotaStickyKeys.set(options.sessionId, next);
							this.tpmHitCounts.delete(options.sessionId);
						}
						continue;
					}
				}
				release();
				release = void 0;
				throw httpError(attempt.status, errText, retryAfterMs, dynamicFloorMs);
			}
			if (response === void 0) throw new LlmError("llm-sensenova: SenseNova API returned no response", "PROVIDER_PROTOCOL_ERROR");
			if (response.body === null) throw new LlmError("llm-sensenova: SenseNova API returned no response body", "PROVIDER_PROTOCOL_ERROR");
			yield* wire === "responses" ? parseResponsesSse(response.body, options.signal, streamIdleMs) : parseOpenAiSse(response.body, options.signal, streamIdleMs);
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
const inject = ["llm", "credentials"];
const NS = "llm-sensenova";
const PROVIDER = "sensenova";
const DEFAULT_API_KEY_ENV = "SENSENOVA_API_KEY";
const DEFAULT_API_BASE = "https://token.sensenova.cn/v1";
function snap(value) {
	return typeof value === "object" && value !== null && typeof value.get === "function" ? value.get() : value;
}
const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV).volatile(),
	apiBase: z.string().default(DEFAULT_API_BASE).volatile(),
	accounts: z.array(z.object({
		id: z.string().default(""),
		label: z.string().default(""),
		apiKeyEnv: z.string().role("credential-ref").default("")
	})).default([]).volatile(),
	activeAccount: z.string().default("").volatile(),
	concurrency: z.natural().min(1).default(1).volatile(),
	quotaRotation: z.boolean().default(false).volatile(),
	wireProtocol: z.union([
		z.const("auto"),
		z.const("responses"),
		z.const("chat-completions")
	]).default("auto").volatile(),
	reasoningSummary: z.union([
		z.const("auto"),
		z.const("concise"),
		z.const("detailed")
	]).default("auto").volatile()
});
/** 把 wire 协议配置归一化为三值枚举（非法输入回退 auto）。 */
function normalizeWireProtocol(value) {
	return value === "responses" || value === "chat-completions" ? value : "auto";
}
/** 把推理摘要配置归一化为三值枚举（非法输入回退 auto）。 */
function normalizeReasoningSummary(value) {
	return value === "concise" || value === "detailed" ? value : "auto";
}
/** 把配置的并发上限归一化为正整数（非正整数/无法解析回退 1）。 */
function normalizeConcurrency(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
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
	const apiKeyEnvRaw = snap(config.apiKeyEnv);
	const apiBaseRaw = snap(config.apiBase);
	const accountsRaw = snap(config.accounts) ?? [];
	const activeAccountRaw = snap(config.activeAccount);
	const accounts = [];
	const defaultEnv = typeof apiKeyEnvRaw === "string" && apiKeyEnvRaw.trim() !== "" ? apiKeyEnvRaw.trim() : DEFAULT_API_KEY_ENV;
	accounts.push(resolveSlot("default", "Default", defaultEnv));
	for (const [index, account] of accountsRaw.entries()) {
		if (account === void 0) continue;
		const refName = typeof account.apiKeyEnv === "string" && account.apiKeyEnv.trim() !== "" ? account.apiKeyEnv.trim() : void 0;
		if (refName === void 0) continue;
		const id = typeof account.id === "string" && account.id.trim() !== "" ? account.id.trim() : `account-${index + 2}`;
		const label = typeof account.label === "string" && account.label.trim() !== "" ? account.label.trim() : `Account ${index + 2}`;
		accounts.push(resolveSlot(id, label, refName));
	}
	return {
		apiBase: typeof apiBaseRaw === "string" && apiBaseRaw.trim() !== "" ? apiBaseRaw.trim() : DEFAULT_API_BASE,
		activeAccount: typeof activeAccountRaw === "string" ? activeAccountRaw : "",
		accounts,
		concurrency: normalizeConcurrency(snap(config.concurrency)),
		quotaRotation: snap(config.quotaRotation) === true,
		wireProtocol: normalizeWireProtocol(snap(config.wireProtocol)),
		reasoningSummary: normalizeReasoningSummary(snap(config.reasoningSummary))
	};
}
function apply(ctx, config) {
	const current = () => config;
	const options = () => resolveAdapterOptions(current());
	const resolveRef = async (spec) => {
		if (spec.isLiteral || !isCredentialRefName(spec.ref)) return void 0;
		const ref = credentialRef(spec.ref);
		const credentials = ctx.get("credentials", false);
		let credentialInfo;
		if (credentials !== void 0) {
			const resolved = await credentials.resolve(ref);
			if (resolved !== void 0 && resolved.value !== void 0 && resolved.value !== "") return resolved.value;
			credentialInfo = await credentials.describe(ref);
		}
		const ambient = launchEnvironmentOf(ctx).get(spec.ref);
		if (ambient !== void 0 && ambient.value.length > 0) return ambient.value;
		if (credentialInfo?.configured === true) throw new LlmError(`llm-sensenova: credential reference "${spec.ref}" is marked configured but resolved no usable value (source ${credentialInfo.source ?? "unknown"}, writable ${credentialInfo.writable}); clear and re-save it through the credentials service`, "INVALID_CREDENTIAL");
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
				wireProtocol: resolved.wireProtocol,
				reasoningSummary: resolved.reasoningSummary
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
}
//#endregion
export { Config, DEFAULT_API_BASE, DEFAULT_API_KEY_ENV, apply, inject, name, normalizeConcurrency, normalizeReasoningSummary, normalizeWireProtocol, resolveAdapterOptions };

//# sourceMappingURL=index.js.map