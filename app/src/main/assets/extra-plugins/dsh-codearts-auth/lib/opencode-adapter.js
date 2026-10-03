/**
 * 某模型的输入模态（`LlmModelInfo` / `LlmResolvedModelInfo` 共用）。
 *
 * ⚠️ **能力表缺失时一律回退 `['text']`** —— 这是本仓库的硬约定：
 * 声明支持就必须真支持（Qoder 图片丢失事故的教训）。把「查不到」当成
 * 「支持」会让 DSH 把图片投影成上游根本不接受的形态。
 */
function inputModalitiesOf(capabilities, modelId) {
    return supportsOpencodeImage(capabilities.find((c) => c.id === modelId)) ? ['text', 'image'] : ['text'];
}
/**
 * OpenCode Zen 模型适配器（账号槽 + 匿名槽平权混合池）。
 *
 * ## 平权轮换语义（设计文档 §5）
 *
 * 槽序列 = `[账号槽…（账号池手动顺序）] + [匿名槽（固定末位）]`。
 * 免费模型下**全序列**参与轮换；收费模型只由账号槽承载（匿名槽被剔除）。
 * 匿名殿后**只是位置，不是特权降级** —— 判据见 {@link pickSlot}。
 *
 * ## 身份即 key + IP + 随机会话
 *
 * opencode CLI 发往 Zen 的请求**没有机器指纹**（1.18.22 源码逐行核对），
 * 故「换一台 PC」在协议层等价于「换一个 key（账号）或换一个出口 IP（代理）」；
 * 指纹派生的作用是**防关联**与满足形状门禁，不参与配额计算。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { OPENCODE, OPENCODE_FALLBACK_MODELS, classifyOpencodeError, isFreeOpencodeModel, isReachableOpencodeModel, } from './opencode-product.js';
import { listIdentitySlots } from './opencode-auth.js';
import { deriveRequestId, deriveSessionId, opencodeHeaders, opencodeUserAgent } from './opencode.js';
import { buildOpencodePayload } from './opencode-messages.js';
import { getOpencodeCapabilitiesSync, supportsOpencodeImage, } from './opencode-capability.js';
import { buildProxyDispatcher } from './opencode-proxy.js';
import { consumeOpenAiSse, collectImages, httpErrorCode, serializeMessages } from './openai-compat.js';
import { registerAdapterIdempotent } from './llm-register-compat.js';
/** 默认目录 TTL（5 分钟，与 opencode2dsh 的 refreshSeconds=300 同档）。 */
const DEFAULT_CATALOG_TTL_MS = 300_000;
const catalogCache = new Map();
/** 清空目录缓存（RPC 的「刷新目录」与单测隔离用）。 */
export function clearOpencodeCatalogCache() {
    catalogCache.clear();
}
/**
 * 拉取远端目录，失败回退静态兜底。
 *
 * @param ttlMs 命中内存缓存的窗口；测试传 0 强制每次都拉。
 *
 * ⚠️ 缓存按**槽 id** 分开存：不同账号的目录可能不同（付费可见性、
 * 地区封锁），共用一份缓存会让新加的账号迟迟看不到付费模型。
 */
export async function loadOpencodeCatalog(fetchCatalog, slot, ttlMs = DEFAULT_CATALOG_TTL_MS) {
    const cached = catalogCache.get(slot.id);
    if (cached !== undefined && ttlMs > 0 && Date.now() - cached.at < ttlMs)
        return cached.entries;
    let entries;
    try {
        const response = await fetchCatalog(slot);
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const body = (await response.json());
        if (!Array.isArray(body.data) || body.data.length === 0)
            throw new Error('空目录');
        const parsed = [];
        const seen = new Set();
        for (const raw of body.data) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const record = raw;
            const id = typeof record.id === 'string' ? record.id : '';
            if (id.length === 0 || seen.has(id))
                continue;
            // ⚠️⚠️ **按实测可达性过滤**（真实报障 2026-10-01）：远端 `/v1/models`
            // 返回全部 84 个模型且**不含协议信息**，直接暴露会让用户点到
            // `ling-3.0-flash-fin-free`（唯一端点已 500）、`claude-*`（我们未实现
            // messages 协议）等必然失败的模型。详见
            // `docs/superpowers/specs/2026-10-02-opencode-zen-endpoint-matrix.md`。
            if (!isReachableOpencodeModel(id))
                continue;
            seen.add(id);
            const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : id;
            const ctx = typeof record.context_window === 'number'
                ? record.context_window
                : typeof record.limit?.context === 'number' ? record.limit.context : 0;
            parsed.push({
                id,
                name,
                // ⚠️ 远端不下发「免费」标记，按本地表判定（表外一律 false）。
                isFree: isFreeOpencodeModel(id),
                // ⚠️ 窗口未知记 0（哨兵），**不编造**：`resolveModel` 判 > 0 才下发。
                contextWindow: Number.isSafeInteger(ctx) && ctx > 0 ? ctx : 0,
            });
        }
        if (parsed.length === 0)
            throw new Error('解析后为空');
        entries = parsed;
    }
    catch {
        entries = OPENCODE_FALLBACK_MODELS;
    }
    catalogCache.set(slot.id, { at: Date.now(), entries });
    return entries;
}
/**
 * 按「平权」规则选一个可用槽。
 *
 * ⚠️ **收费模型跳过匿名槽**：匿名凭证（字面量 `public`）只被服务端认作
 * 免费通道，送付费模型必然 401/403。
 *
 * @param excluded 已试过的槽 id（`tried` 集合）——保证每个槽最多试一次。
 */
export function pickSlot(slots, modelId, excluded) {
    for (const slot of slots) {
        if (excluded.has(slot.id))
            continue;
        if (slot.kind === 'anonymous' && !isFreeOpencodeModel(modelId))
            continue;
        return slot;
    }
    return undefined;
}
/** 限流退避上限：服务端再狠也不让它单次阻塞超过 30 分钟。 */
const RETRY_AFTER_CAP_MS = 30 * 60_000;
/** 匿名/账号额度穷尽时的默认标记时长（当日额度）。 */
const FREE_USAGE_DEFAULT_MS = 24 * 60 * 60_000;
/** 首次 429 的默认冷却。 */
const RATE_LIMIT_BASE_MS = 60_000;
/**
 * 把「错误语义 + 服务端给的延迟」换算成该槽该模型的受限时长（相对 now 的毫秒数）。
 *
 * ⚠️ **服务端给了就用它的**，且 **0 是合法值**（「立即解除」而非「未知」）：
 * 必须用 `retryAfterMs === undefined` 判空，写成 `?? default` 之外的任何
 * falsy 判据都会把 0 静默换成 1 小时 —— 那会让刚恢复的账号继续被跳过。
 * ⚠️ 没给才退避：`free_usage_limit` 按当日 24h（与 qoder 的「当日额度」同思路），
 * `rate_limit` 指数退避并封顶 30 分钟（否则单次阻塞可能数小时，UI 无法区分
 * 「在等」与「卡死」）。
 */
export function opencodeRetryAfterMs(kind, retryAfterMs, attempt) {
    if (retryAfterMs !== undefined)
        return Math.max(0, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS));
    if (kind === 'free_usage_limit')
        return FREE_USAGE_DEFAULT_MS;
    // ⚠️ 余额不足（402）：按**当日**标记，而不是短冷却 —— 钱不会在 60 秒内到账，
    // 短冷却会让同一个空钱包账号被反复选中、反复 402。
    if (kind === 'quota')
        return 24 * 60 * 60_000;
    if (kind === 'auth')
        return RATE_LIMIT_BASE_MS;
    return Math.min(RATE_LIMIT_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_AFTER_CAP_MS);
}
export class OpencodeAdapter extends LlmAdapter {
    options;
    constructor(options) {
        super();
        this.options = options;
    }
    providerInfo(provider) {
        const id = typeof provider === 'string' && provider.length > 0 ? provider : OPENCODE.id;
        return { id, name: OPENCODE.displayName };
    }
    async catalog() {
        const slots = await this.options.identitySlots();
        // 目录用「账号槽优先」的那一身份拉取：付费模型只在认证通道的目录里
        // 完整，匿名目录看不到它们。
        const slot = slots.find((s) => s.kind === 'account') ?? slots.at(-1);
        if (this.options.fetchRemoteCatalog === undefined || slot === undefined) {
            return OPENCODE_FALLBACK_MODELS;
        }
        // ⚠️ **不要**在适配器上再 memoize 一份：那会让目录永不过期 ——
        // 用户后加一个账号（付费模型本应随之可见）要重启 DSH 才能看到，
        // 表现为「key 明明有效却不显示付费模型」。刷新职责交给带 TTL 的
        // `loadOpencodeCatalog`（默认 5 分钟）。
        return loadOpencodeCatalog(this.options.fetchRemoteCatalog, slot);
    }
    /**
     * 完整目录（**同步**返回数组）。
     *
     * ⚠️ **绝不能写成 async**：`jet-hub-rpc.ts` 的 `ModelCatalogSource`
     * 接口是同步的且消费者**不 await**（`catalog = [...all]`），
     * 返回 Promise 会抛 `TypeError: all is not iterable`
     * （minimax 的同款真实缺陷，见 `minimax-adapter.ts` 的注释）。
     */
    listAllModels() {
        return OPENCODE_FALLBACK_MODELS.map((m) => ({ id: m.id, name: m.name, isFree: m.isFree }));
    }
    async listModels(_provider) {
        const slots = await this.options.identitySlots();
        // 无任何槽 = 连匿名槽都没了（异常态）：返回空数组隐藏 provider 分组，
        // **不抛错**（抛错会多一条 provider 级报错，UI 表现为「供应商加载失败」）。
        if (slots.length === 0)
            return [];
        const all = await this.catalog();
        // ⚠️ 可见性口径（用户定稿）：只有匿名身份时**只给免费模型**。
        // 免费判定以**远端 models.dev 的 cost** 为准（见 opencode-capability.ts）。
        const hasAccountSlot = slots.some((s) => s.kind === 'account');
        const visible = hasAccountSlot ? all : all.filter((m) => m.isFree);
        const disabled = this.options.disabledModels?.() ?? new Set();
        // ⚠️ **同步**读能力表（不 await）：渲染路径上等网络会让模型选择器一直空白
        // （真机事故 2026-10-02）。拿不到就按纯文本兜底，后台补齐后会重渲染。
        const capabilities = getOpencodeCapabilitiesSync();
        return visible
            .filter((m) => !disabled.has(m.id))
            .map((m) => ({
            provider: OPENCODE.id,
            id: m.id,
            name: m.name,
            // ⚠️ 模态以**远端能力表**为准，不再一律 text（用户报障
            // 「space-bunny-free 发图提示不支持」：该模型实测接受图片，
            // 而我们硬编码 ['text'] 让 DSH 在本地就把图投影成了文字占位符）。
            // ⚠️ 能力表拿不到时**保守回退 text**（`inputModalitiesOf` 的实现）——
            // 声明支持就必须真支持，这是本仓库的硬约定。
            inputModalities: inputModalitiesOf(capabilities, m.id),
        }));
    }
    async resolveModel(provider, model, _signal) {
        const all = await this.catalog();
        const entry = all.find((m) => m.id === model);
        const capabilities = getOpencodeCapabilitiesSync();
        const resolved = {
            provider,
            id: model,
            name: entry?.name ?? model,
            inputModalities: inputModalitiesOf(capabilities, model),
        };
        // ⚠️ 窗口未知**不编造**：0 是「不知道」哨兵，不能当合法窗口下发。
        if (entry !== undefined && entry.contextWindow > 0) {
            resolved.context = { contextWindow: entry.contextWindow };
        }
        return resolved;
    }
    async prepareCall(provider, model, signal) {
        return { model: await this.resolveModel(provider, model, signal), stream: (o) => this.stream(o) };
    }
    /**
     * 平权轮换：失败按「语义」标记该槽 → 换下一槽重发。
     *
     * ⚠️ 三条硬规则（每条都对应一类真实缺陷）：
     *
     * 1. `tried` **跨迭代保留** —— 每次迭代重置会让两个槽之间无限来回
     *    （qoder 实测：标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
     * 2. **已交付内容的流不重放** —— 重放会让用户看到重复输出。
     * 3. 收费模型**不经匿名槽**（匿名凭证只认免费模型，见 `pickSlot`）。
     */
    async *stream(options) {
        const slots = await this.options.identitySlots();
        if (slots.length === 0) {
            throw new LlmError('opencode: 没有可用通道', 'MISSING_CREDENTIAL');
        }
        // ⚠️ **先判「有没有任何槽能承载这个模型」**，再进轮换：
        // 收费模型 + 无账号槽是**配置问题**（用户没加 key），不是配额问题。
        // 混进轮换会让它以「所有通道均受限 / QUOTA_EXCEEDED」的面目出现 ——
        // 用户看到「额度用尽」却根本不知道自己缺的是 API key（写单测时实测到）。
        if (pickSlot(slots, options.model, new Set()) === undefined) {
            throw new LlmError(`opencode: 模型 "${options.model}" 需要 API key 账号通道（匿名通道只支持免费模型），`
                + '请先在 Jet Hub 的 OpenCode 面板添加一个账号', 'MISSING_CREDENTIAL');
        }
        const tried = new Set();
        const limited = [];
        for (;;) {
            const slot = pickSlot(slots, options.model, tried);
            if (slot === undefined) {
                // 全 tried ⇒ 每个槽都试过一次。收费模型走到这里通常是「没有账号槽」。
                throw new LlmError(`opencode: 所有通道对该模型均受限${limited.length > 0 ? `（${limited.join('、')}）` : ''}`, 'QUOTA_EXCEEDED');
            }
            tried.add(slot.id);
            let delivered = false;
            try {
                for await (const chunk of this.streamVia(slot, options)) {
                    // ⚠️ **任何 chunk 产出都算「已交付」**：本仓库的 `StreamChunk` 联合
                    // （`block-start` / `*-delta` / `block-end` / `usage` / `finish`）里
                    // **没有**「内容之前的前置事件」—— 原设计假设有个 `start` 事件，
                    // 实际类型里不存在（tsc 直接报 TS2367 点破了它）。既然不存在，
                    // 区分「前置」与「内容」就无从谈起，保守取「一律算交付」：
                    // 宁可漏掉一次可切换的机会，也绝不重放（重放会让用户看到重复输出）。
                    delivered = true;
                    yield chunk;
                }
                return;
            }
            catch (error) {
                if (delivered)
                    throw error;
                if (error instanceof LlmError && error.code === 'QUOTA_EXCEEDED')
                    throw error;
                const info = classifyOpencodeFailure(error);
                if (info.kind === 'free_tier') {
                    // ⚠️⚠️ 根因是 **session id 形状**，不是「伪装不被认可」（真实报障
                    // 2026-10-01 定位）。证据：尾段写成 38 字符（12hex + 26 base62）时
                    // 一律 403；改成官方真实的 26 字符（12hex + 14 base62）后**同样的
                    // 请求立刻成功**（`tests/unit/opencode-identity.spec.ts` 有形状回归锁）。
                    //
                    // ⇒ 若这里还收到 FreeTierError，说明形状又错了（或上游加了新门禁）。
                    // **换槽/换 key 无用**（每槽发的形状完全相同），故不重试，
                    // 直接把「形状」这条线索写进文案，便于一眼定位。
                    this.options.warn?.(`opencode: 免费通道被 FreeTierError 拒绝 —— 检查 session id 形状（应为 ses_ + 12hex + 14base62）：${info.detail}`);
                    throw new LlmError(`opencode: 免费通道被上游拒绝（FreeTierError）。`
                        + '该错误由请求形状触发（session id 形状不对时出现），换 API key 或换出口都无效。', 'AUTH', { status: 403 });
                }
                if (info.kind === 'quota') {
                    // 402 / 余额不足：换槽无意义（同账号的钱包是同一个），但**换账号有意义**。
                    // ⚠️ 不能当 server 处理 —— harness 会重试 5 次（约 15 秒）而永远不会成功。
                    await this.options.markLimited?.(slot.id, options.model, Date.now() + 24 * 60 * 60_000);
                    limited.push(`${slot.id}(余额不足)`);
                    continue;
                }
                if (info.kind === 'auth') {
                    // 认证失败（401/403 无类型名）：**标记并切下一个账号**是对的，
                    // 但**不能**把它当限流那样「耗尽所有槽后报 QUOTA_EXCEEDED」——
                    // 匿名槽失败时只有它一个，报「所有通道均受限」会让用户以为要等额度，
                    // 而真实原因是「这条通道没凭证/不被接受」。故最后一次失败直接透传。
                    if (tried.size >= slots.length)
                        throw error;
                    await this.options.markLimited?.(slot.id, options.model, Date.now() + RATE_LIMIT_BASE_MS);
                    limited.push(`${slot.id}(认证失败)`);
                    continue;
                }
                if (info.kind === 'server' || info.kind === 'transport') {
                    // 上游故障/网络问题：不标记（不是配额问题），只换下一个。
                    this.options.warn?.(`opencode: 通道 ${slot.id} ${info.kind}，换下一个：${info.detail}`);
                    continue;
                }
                // 限流 / 额度 / 认证：标记该槽后换下一个。
                const resetAtMs = Date.now() + opencodeRetryAfterMs(info.kind, info.retryAfterMs, tried.size);
                await this.options.markLimited?.(slot.id, options.model, resetAtMs);
                limited.push(`${slot.id}(${info.kind})`);
            }
        }
    }
    /**
     * 解析消息里的图片附件为 data URL。
     *
     * ⚠️ **模型不支持图片时直接抛 UNSUPPORTED_CONTENT**（而不是静默丢弃）——
     * 静默丢弃会让用户以为模型看到了图（Qoder 图片事故的教训）。
     * ⚠️ 附件字节读不出来时写入**空 Map**：`openai-compat` 的
     * `userContentParts` 遇到缺失会产出 `[image unavailable]` 占位，
     * 至少让模型知道「这里本该有张图但没拿到」，而不是消息里凭空少一块。
     */
    async resolveImageUrls(model, messages) {
        const refs = new Map();
        for (const message of messages) {
            if (Array.isArray(message.content))
                collectImages(message.content, refs);
        }
        if (refs.size === 0)
            return undefined;
        const capabilities = getOpencodeCapabilitiesSync();
        if (!supportsOpencodeImage(capabilities.find((c) => c.id === model))) {
            throw new LlmError(`opencode: 模型 "${model}" 不支持图片输入（能力以远端 models.dev 为准）`, 'UNSUPPORTED_CONTENT');
        }
        if (this.options.readImage === undefined) {
            throw new LlmError('opencode: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT');
        }
        const readImage = this.options.readImage;
        const out = new Map();
        for (const [id, ref] of refs) {
            const image = await readImage(ref);
            if (image === undefined)
                continue;
            out.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`);
        }
        return out;
    }
    /** 用指定槽发一次请求（轮换循环的复用单元）。 */
    async *streamVia(slot, options) {
        // ⚠️ **图片**：`inputModalities` 声明了 image 的模型，DSH 才会把图片
        // 投影进消息；序列化时要用 `imageUrls` 把 attachmentId 换成 data URL，
        // 否则图片会被静默丢掉（Qoder 图片丢失事故的同型缺陷）。
        const imageUrls = await this.resolveImageUrls(options.model, options.messages);
        const messages = serializeMessages(options.messages, imageUrls);
        const payload = buildOpencodePayload({
            model: options.model,
            messages,
            ...options.system !== undefined && options.system.length > 0 ? { system: options.system } : {},
            ...options.tools !== undefined ? { tools: options.tools } : {},
            ...options.temperature !== undefined ? { temperature: options.temperature } : {},
            ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
        });
        const headers = {
            ...opencodeHeaders(slot.fingerprint, sessionIdOf(options), deriveRequestId(), opencodeUserAgent(slot.userAgent)),
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${slot.apiKey}`,
        };
        const init = {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            ...options.signal !== undefined ? { signal: options.signal } : {},
            // ⚠️ per-request dispatcher：只让本 provider 的这次请求走该账号的出口，
            // **不动全局**（两个插件抢全局槽位会互相短路整个路由层）。
            ...slot.proxy === undefined ? {} : { dispatcher: buildProxyDispatcher(slot.proxy) },
        };
        const response = await fetch(`${OPENCODE.baseUrl}${OPENCODE.chatPath}`, init);
        if (!response.ok) {
            // ⚠️ **必须先读体**：Zen 的限流语义（`GoUsageLimitError`）在响应体里，
            // 而 body 只能读一次 —— 读了不传下去，轮换层就只能按状态码猜，
            // 把「额度耗尽」误判成「key 失效」（HTTP 层的 httpErrorCode 就会这么干）。
            const text = await response.text().catch(() => '');
            throw new LlmError(`opencode: HTTP ${response.status} — ${text.slice(0, 300)}`, httpErrorCode(response.status), {
                status: response.status,
                // ⚠️ 走 dsh-llm 的**官方契约**字段（`LlmErrorOptions`）：
                // 上游给的等待时长不必自己发明字段名，harness 也认它。
                ...parseRetryAfterHeader(response.headers) === undefined
                    ? {}
                    : { providerRetryAfterMs: parseRetryAfterHeader(response.headers) },
            });
        }
        yield* consumeOpenAiSse(response, options.signal !== undefined ? { signal: options.signal } : {}, {
            label: 'opencode',
            firstTokenTimeoutMs: OPENCODE.chatHeaderTimeoutMs,
            chunkTimeoutMs: OPENCODE.chatChunkTimeoutMs,
            ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
        });
    }
}
/**
 * 读 `retry-after` 响应头（秒数或 HTTP 日期）→ 毫秒。
 *
 * ⚠️ **0 是合法值**（「立即解除」），故调用方必须用 `=== undefined` 判空；
 * 任何 falsy 判据都会把 0 变成「未知」再退避一小时。
 */
function parseRetryAfterHeader(headers) {
    const raw = headers.get('retry-after');
    if (raw === null || raw === '')
        return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.ceil(seconds * 1000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
/**
 * 从 `LlmError` 还原成语义化分类。
 *
 * ⚠️ 事实挂在 `error.failure` 上（`LlmFailure` 契约），**不是**展开在 error 自身
 * —— 早期版本误按「自身属性」读响应头，`retry-after` 因此永远读不到，
 * 于是 `GoUsageLimitError` 的 600 秒被当成「未知」退化成 1 分钟
 * （写单测时实测到：`expected 590000, got 60000`）。
 *
 * 分类仍以**响应体文案里的类型名**为准（`message` 里带着前 300 字原文），
 * HTTP 状态码只作辅助 —— Zen 的额度错误经常带 403。
 */
function classifyOpencodeFailure(error) {
    const failure = (typeof error === 'object' && error !== null ? error : {});
    const status = typeof failure.failure?.status === 'number' ? failure.failure.status : 0;
    const providerRetryAfterMs = typeof failure.failure?.providerRetryAfterMs === 'number'
        && Number.isFinite(failure.failure.providerRetryAfterMs)
        ? failure.failure.providerRetryAfterMs
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    const info = classifyOpencodeError(status, message);
    return providerRetryAfterMs === undefined
        ? info
        : { ...info, retryAfterMs: info.retryAfterMs ?? providerRetryAfterMs };
}
/**
 * 会话级 session id：同一 DSH 会话内保持稳定。
 */
const sessionIds = new WeakMap();
function sessionIdOf(options) {
    const key = options.messages;
    if (typeof key !== 'object' || key === null)
        return deriveSessionId();
    const existing = sessionIds.get(key);
    if (existing !== undefined)
        return existing;
    const created = deriveSessionId();
    sessionIds.set(key, created);
    return created;
}
/** 在 `ctx.llm` 上注册 opencode 路由。 */
export function registerOpencodeLlm(ctx, options) {
    const adapter = new OpencodeAdapter(options);
    registerAdapterIdempotent(ctx.llm, [OPENCODE.id], adapter);
    return adapter;
}
export { listIdentitySlots };
//# sourceMappingURL=opencode-adapter.js.map