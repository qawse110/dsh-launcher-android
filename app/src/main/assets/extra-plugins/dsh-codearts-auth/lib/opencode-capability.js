/**
 * OpenCode Zen 模型能力元数据（远端下发 + 磁盘缓存 + **非阻塞**读取）。
 *
 * ## 数据源：models.dev 的 `opencode` 条目
 *
 * `/zen/v1/models` **只返回 4 个字段**（`id` / `object` / `created` /
 * `owned_by`，实测 85 条全如此），**不含任何能力信息**。能力在 models.dev
 * （`https://models.dev/api.json` 的 `opencode` 键，实测 115 个模型），官方
 * CLI 自己就用它（`packages/core/src/models-dev.ts`）。
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `modalities.input` | 能力主源：`['text']` / `['text','image']` … |
 * | `cost.input` / `cost.output` | **免费判定的权威来源**（0 = 免费） |
 * | `limit.context` / `limit.output` | 上下文窗口与输出上限 |
 *
 * ## ⚠️⚠️ 为什么读取**必须非阻塞**（真机事故 2026-10-02）
 *
 * `https://models.dev/api.json` 实测 **5.05 MB / 首字节 720ms / 下载 1.4s**
 * （轻量端点 `api/v1/opencode.json` 返回的是 HTML 404 页，不可用）。
 *
 * 我最初在 `listModels` / `resolveModel` 里**直接 await** 这个拉取，于是
 * DSH 的模型选择器必须等 1.4s+ 才能拿到列表 → **点开是一片空白**，
 * 用户报障「选择模型还是点击没弹出列表」。
 *
 * ⇒ 三条硬约定（改动前先读）：
 * 1. **渲染路径上只能读同步缓存**，永不 await 网络；
 * 2. 磁盘缓存落 `$DSH_HOME/cache/opencode-capabilities.json`，冷启动直接命中；
 * 3. 拉取在**后台**进行，完成后广播 `llm/adapters-updated` 让 DSH 重读目录。
 *
 * 缓存拿不到时**保守回退纯文本**（声明支持就必须真支持），徽标与图片能力
 * 会在后台刷新后自动补上。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPENCODE_MODELS_DEV_URL, OPENCODE_MODELS_DEV_TTL_MS } from './opencode-product.js';
/**
 * 实测校准表：**只**覆盖与 models.dev 不一致的视觉能力。
 *
 * ## 范围（用户定调 2026-10-02：只验证免费模型）
 *
 * 校准**只针对免费模型**。付费模型走账号通道，能力以远端 models.dev 为准即可，
 * 不做逐个实测 —— 那需要真实付费调用，且余额/价格变动时结论也易过期。
 */
const MEASURED_IMAGE_OVERRIDES = {
    // 实测 2026-10-02：models.dev 标 `modalities.input: ["text"]`，
    // 但 1×1 PNG 的多模态请求真实返回 200（big-pickle 是最常用的免费模型）。
    'big-pickle': { image: true, note: '2026-10-02 实测 200，models.dev 漏报 image' },
    // 实测 2026-10-02：models.dev 标支持 image，但带图请求真实 500
    // （"Upstream request failed: Endpoint is unsupported"）。
    'longcat-2.5-preview-free': { image: false, note: '2026-10-02 实测 500，models.dev 多报 image' },
};
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
/** 把 models.dev 的一个条目归一；不合法时返回 null。 */
function normalizeEntry(id, raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const entry = raw;
    const declared = Array.isArray(entry.modalities?.input)
        ? entry.modalities.input.filter((m) => typeof m === 'string')
        : [];
    // ⚠️ **video / audio / pdf 一律降级为 text**：DSH 的 `inputModalities` 只认
    // 这两个值，声明不存在的模态会让 DSH 投影出我们并不发送的内容。
    let modalities = ['text'];
    if (declared.includes('image'))
        modalities = ['text', 'image'];
    const override = MEASURED_IMAGE_OVERRIDES[id];
    if (override !== undefined)
        modalities = override.image ? ['text', 'image'] : ['text'];
    return {
        id,
        name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
        modalities,
        contextWindow: isFiniteNumber(entry.limit?.context) ? entry.limit.context : 0,
        maxOutputTokens: isFiniteNumber(entry.limit?.output) ? entry.limit.output : 0,
        reasoning: entry.reasoning === true,
        toolCall: entry.tool_call !== false,
        isFree: isFiniteNumber(entry.cost?.input) && entry.cost.input === 0
            && isFiniteNumber(entry.cost?.output) && entry.cost.output === 0,
    };
}
/** 能力表缓存文件路径（`$DSH_HOME/cache` 下，与宿主缓存同处）。 */
function cacheFilePath() {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
    return join(home, 'cache', 'opencode-capabilities.json');
}
/** 进程内同步可读的缓存（渲染路径只读它，绝不 await）。 */
let memory = [];
/** 磁盘缓存的写入时刻（0 = 无缓存），供 TTL 判定。 */
let cacheFileAt = 0;
/** 后台拉取是否已在进行（去重，避免并发重复下载 5 MB）。 */
let refreshing;
/** 磁盘缓存读一次（冷启动路径）。 */
let diskLoaded = false;
async function ensureDiskLoaded() {
    if (diskLoaded)
        return;
    diskLoaded = true;
    try {
        const raw = await readFile(cacheFilePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1 && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
            memory = parsed.entries;
            cacheFileAt = typeof parsed.at === 'number' ? parsed.at : 0;
        }
    }
    catch {
        // 首次运行没有缓存文件是**正常**的（不是错误），走纯文本兜底。
    }
}
async function writeDiskCache(entries) {
    try {
        const path = cacheFilePath();
        await mkdir(join(path, '..'), { recursive: true });
        const payload = { version: 1, at: Date.now(), entries };
        await writeFile(path, JSON.stringify(payload), 'utf8');
    }
    catch {
        // 缓存写失败不影响功能（下次仍会从网络补齐）
    }
}
/** 单次拉取的超时（毫秒）。
 *
 * ⚠️ **必须有**：`fetch` 在某些宿主网络环境（代理未起、TUN 未连通）下
 * 会**永不 settle**（用户报障「模型选择一直卡着」，实测非慢而是挂死）。
 * 没有超时 = 后台任务永久悬挂，且它还占着 `refreshing` 去重位，
 * 导致后续所有刷新请求都被跳过。
 */
const FETCH_TIMEOUT_MS = 20_000;
async function fetchAndCache() {
    const response = await fetch(OPENCODE_MODELS_DEV_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    const body = (await response.json());
    const models = body['opencode']?.models;
    if (typeof models !== 'object' || models === null)
        throw new Error('缺少 opencode 条目');
    const out = [];
    for (const [id, raw] of Object.entries(models)) {
        const entry = normalizeEntry(id, raw);
        if (entry !== null)
            out.push(entry);
    }
    if (out.length === 0)
        throw new Error('解析结果为空');
    memory = out;
    await writeDiskCache(out);
}
/**
 * 后台刷新能力表（**永不阻塞**调用方）。
 *
 * @param onUpdated 刷新成功后的回调（接线层用它广播 `llm/adapters-updated`，
 *                  让 DSH 重读目录并按新能力重渲染）。
 * @param force 忽略 TTL 强制刷新（「刷新目录」按钮用）。
 */
export function refreshOpencodeCapabilities(onUpdated, force = false) {
    // ⚠️ 上一次拉取若**卡住**（fetch 永不 settle 且超时信号未生效的极端情况），
    // `refreshing` 会被永久占住，之后所有刷新都被跳过、缓存也永远补不上。
    // 故超过两倍超时即视为「上一次已死」，允许重新发起。
    if (refreshing !== undefined && Date.now() - refreshingStartedAt > FETCH_TIMEOUT_MS * 2) {
        refreshing = undefined;
    }
    if (refreshing !== undefined)
        return;
    refreshingStartedAt = Date.now();
    refreshing = (async () => {
        try {
            await ensureDiskLoaded();
            // 磁盘缓存足够新就不重复下载 5 MB。
            if (!force && cacheFileAt > 0 && Date.now() - cacheFileAt < OPENCODE_MODELS_DEV_TTL_MS)
                return;
            await fetchAndCache();
            onUpdated?.();
        }
        catch {
            // 拉取失败（含超时）：保留现有缓存继续用（能力退化为上一次的读数，而不是清空）
        }
        finally {
            refreshing = undefined;
        }
    })();
}
/** 在途拉取的开始时刻（用于识别「卡死」的那一次，见 refreshOpencodeCapabilities）。 */
let refreshingStartedAt = 0;
/**
 * **同步**读当前已知的能力表。
 *
 * ⚠️ 刻意**不是** async：调用方在渲染路径上（listModels / resolveModel），
 * await 网络会卡住模型选择器（真机事故）。拿不到就返回空数组，
 * 调用方按「纯文本」兜底，后台刷新后自动补上。
 */
export function getOpencodeCapabilitiesSync() {
    return memory;
}
/** 首次调用：读磁盘缓存（非阻塞，fire-and-forget）。 */
export function primeOpencodeCapabilities() {
    void ensureDiskLoaded().then(() => {
        // 有缓存就直接用；没有则在后台补一次。
        if (memory.length === 0)
            refreshOpencodeCapabilities();
    });
}
/** 清空内存与磁盘缓存（单测用）。 */
export async function clearOpencodeCapabilitiesCache() {
    memory = [];
    cacheFileAt = 0;
    diskLoaded = false;
    try {
        const { unlink } = await import('node:fs/promises');
        await unlink(cacheFilePath());
    }
    catch {
        // 文件不存在是正常的
    }
}
/** 某模型是否接受图片输入（未知模型按纯文本处理）。 */
export function supportsOpencodeImage(capability) {
    return capability?.modalities.includes('image') === true;
}
//# sourceMappingURL=opencode-capability.js.map