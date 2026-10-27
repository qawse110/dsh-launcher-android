import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { signRequestHuawei } from './sign.js';
/**
 * opengw 网关配置端点 — 返回 benefit（免费额度）模型列表（glm-5.3-flash 等）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 */
export const OPENGW_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config';
/**
 * snap-access 内置模型列表端点 — 返回常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）。
 * 响应结构：{ count, builtinModels: [{ model_id, model_name, ... }] }。
 * 用 AK/SK 签名 + Agent-Type: PromptCenter header。
 * 替代旧 SNAP_STATISTICS_URL（statistics/plugin 已不再返回 model_metrics）。
 */
export const SNAP_MODEL_BUILTIN_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin';
/** 远端动态模型列表缓存文件名（~/.cache/deveco/codearts_models.json）。 */
const CODEARTS_MODELS_CACHE_FILENAME = 'codearts_models.json';
/**
 * benefit（免费额度）模型 id 集合的缓存文件名
 * （~/.cache/deveco/codearts_benefit_models.json）。
 *
 * 与模型列表分开缓存：判定 `maas_type` 只关心 id 集合，且 chat 请求在每次
 * 签名前都要查它，独立文件可避免解析整份模型元数据。
 */
const CODEARTS_BENEFIT_CACHE_FILENAME = 'codearts_benefit_models.json';
/**
 * 远端不可用时的 benefit 模型兜底集合。
 *
 * **为什么需要它**：benefit 模型调用必须带 `maas_type: benefit`（参与
 * SDK-HMAC-SHA256 签名），否则后端返回
 * `InferHub.002002009.404 The model is not registered`。该集合的权威来源是
 * `opengw gateway/config` 的 `result.models`（见 {@link fetchCodeArtsRemoteModels}），
 * 但首次启动、未登录或远端拉取失败时拿不到，故保留一份兜底。
 *
 * 实证（2026-09-23，对齐 deveco-code-rust fb1b4a2）：
 * 1. IDE kernel 日志的 `inferhub-provider [header-debug] full headers` 显示
 *    `deepseek-v4.1-flash` 的实际出站请求带 `"maas_type":"benefit"`；
 * 2. 逐个对照两个端点的模型：`gateway/config` 的模型（glm-5.3-flash、
 *    deepseek-v4.1-flash 等）不带该头一律 404 not registered、带上即成功；
 *    而 `/v1/model/builtin` 的模型（GLM-5.2 等）带上反而 `unsupported model`。
 *
 * ⚠️ `deepseek-v4-flash` / `deepseek-v4-pro`（无日期后缀）**不在**此集合：
 * 它们是后端另外注册的非 benefit 模型，带上 maas_type 会报 unsupported model。
 * 尤其注意 gateway/config 返回的是它们的**带日期后缀**形态
 * （`deepseek-v4-flash-0731`），归一化后落到这两个 id —— 绝不能连带标成 benefit。
 */
export const CODEARTS_BENEFIT_FALLBACK = ['glm-5.3-flash', 'deepseek-v4.1-flash'];
/** 动态模型拉取超时（ms）。 */
const FETCH_TIMEOUT_MS = 10_000;
/** 定时刷新远端模型列表的间隔（2 小时）。 */
export const MODEL_REFRESH_INTERVAL_MS = 2 * 3_600_000;
/** 两个来源是否**都**取到了。 */
export function isRemoteCatalogComplete(outcome) {
    return outcome.gatewayOk && outcome.builtinOk;
}
/** 模块级内存缓存：远端拉取或磁盘加载后填充；availableCodeArtsModels 优先读取。 */
let memoryCache;
/** benefit 模型 id 集合的内存缓存：远端拉取或磁盘加载后填充。 */
let benefitMemoryCache;
/**
 * 去掉模型 id 末尾的日期版本后缀：deepseek-v4-flash-0731 → deepseek-v4-flash。
 * 远端 gateway/config 返回带日期后缀的 model_id（-0731 = 7月31日版本），
 * 但 chat 端点只认不带后缀的 id（InferHub.002002009.404 "model is not registered"）。
 * 仅匹配末尾 -NNNN（4 位数字），避免误去 glm-5.3-flash 等无后缀 id。
 */
export function normalizeModelId(id) {
    if (id.length > 5) {
        const suffix = id.slice(-5);
        if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) {
            return id.slice(0, -5);
        }
    }
    return id;
}
function parseModelInfo(m, seen, 
/** 取倍率时用的「现在」（单测注入；缺省 `Date.now()`）。 */
nowMs) {
    const rawId = m['model_id'];
    if (typeof rawId !== 'string' || rawId.length === 0)
        return undefined;
    const id = normalizeModelId(rawId);
    // 过滤视觉（VL）多模态模型
    // id 含 -VL- 或以 -VL 结尾（如 Qwen3-VL-235B），上下文小、不支持工具调用，
    // 不适合当 agent 主模型，从列表隐藏；只通过 analyzeImage 等工具间接调用。
    if (id.includes('-VL-') || id.endsWith('-VL'))
        return undefined;
    const rawName = m['model_name'];
    const name = typeof rawName === 'string' && rawName.length > 0 ? normalizeModelId(rawName) : id;
    if (seen.has(id))
        return undefined;
    seen.add(id);
    return { id, name, ...readRateLabel(m, nowMs) };
}
/**
 * 从 `/v1/model/builtin` 的单条模型里读**展示用倍率串**。
 *
 * ## 字段实况（2026-10-21 真机取证，8 个模型）
 *
 * ```json
 * "credit": [{ "ratio":"0.05", "ratio_display":"0.7x", "before_display_ratio":null }]
 * ```
 *
 * 6 个常规模型有 `credit[0]`，两个 VL 模型（`Qwen3-VL-235B` / `kimi-k2.6-vl`）
 * **整个 `credit` 数组为空**（它们上面已被 `parseModelInfo` 滤掉，这里只是顺带记下）。
 *
 * ⚠️ **只取 `ratio_display`，不取 `ratio`**：
 * 两个字段不同量纲（见 `RemoteModel.rateLabel` 的注释），用 `ratio` 拼串
 * 会显示出一个上游主界面从未出现过的数字。
 *
 * ⚠️ 任何一步取不到就返回空对象（**不落 `rateLabel` 键**）—— 调用方据此
 * 保持裸名，与「上游没给倍率」完全同形（绝不用占位值冒充）。
 */
function readRateLabel(m, nowMs = Date.now()) {
    const credit = m['credit'];
    if (!Array.isArray(credit) || credit.length === 0)
        return {};
    // ⚠️ **按时段选档**，不是无脑取 `credit[0]`（2026-10-21 真实缺陷）。
    //    `deepseek-v4.1-flash` 有两档，且**当前生效的可能是第二档**：
    //      · `default`  → 0.18x
    //      · `off_peak` → 0.09x（每晚 21:00 起、持续 11 小时 = 至次日 7:59，Asia/Shanghai）
    //    取 `credit[0]` 会在整个错峰时段显示**过高的 0.18x**（用户当场发现）。
    const slots = m['time_slots'];
    const picked = pickActiveCredit(credit, slots, nowMs);
    if (picked === undefined)
        return {};
    const display = picked['ratio_display'];
    if (typeof display !== 'string' || display.length === 0)
        return {};
    return { rateLabel: display };
}
/**
 * 从 `credit[]` 里挑出**当前时段生效**的那一档。
 *
 * ## 实况（2026-10-21 真机取证）
 *
 * ```json
 * "time_slots": {
 *   "off_peak": { "timezone":"Asia/Shanghai", "schedule":"0 0 21 * * *",
 *                 "duration":11, "timeunit":"hour", ... },
 *   "default":  { "schedule":null, "duration":null }
 * }
 * ```
 *
 * ⇒ `schedule` 是 **6 段 cron（秒 分 时 日 月 周）**，`duration`+`timeunit` 给窗口长度。
 * 只有 `deepseek-v4.1-flash` 真正带时段；`openpangu-2.0-pro` 虽有两档，但两档的
 * `time_slot_id` 都是 `null`、display 也相同 ⇒ 取任一都对。
 *
 * ⚠️ **不做通用 cron 解析器**（本仓红线：不为一种上游形态臆造一套通用实现）。
 * 只认已实测的这一种：固定的「时分 + 小时时长」窗口；解析不出就退回
 * `credit[0]`（与上游「无时段」时同形）。
 */
function pickActiveCredit(credit, slots, nowMs) {
    const entries = credit.filter((c) => typeof c === 'object' && c !== null);
    if (entries.length === 0)
        return undefined;
    if (typeof slots !== 'object' || slots === null)
        return entries[0];
    for (const entry of entries) {
        const slotId = entry['time_slot_id'];
        if (typeof slotId !== 'string')
            continue;
        const slot = slots[slotId];
        if (typeof slot !== 'object' || slot === null)
            continue;
        if (isTimeSlotActive(slot, nowMs))
            return entry;
    }
    return entries[0];
}
/**
 * 判断一个 `time_slot` 此刻是否生效。
 *
 * ⚠️ 时区**硬取 Asia/Shanghai**（上游明确下发 `timezone` 字段，且本仓已有
 * 同口径先例：`auto-checkin.ts` 的 `utc8DateString` 用算术平移而非本机时区
 * —— 用户出差/改系统时区时不该改变结果）。
 */
function isTimeSlotActive(slot, nowMs) {
    const schedule = slot['schedule'];
    if (typeof schedule !== 'string' || schedule.length === 0)
        return false;
    // 6 段 cron：秒 分 时 日 月 周（实测形态 `0 0 21 * * *`）
    const parts = schedule.trim().split(/\s+/);
    if (parts.length < 3)
        return false;
    const hour = Number(parts[2]);
    const minute = Number(parts[1]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute))
        return false;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
        return false;
    const duration = Number(slot['duration']);
    const unit = slot['timeunit'];
    if (!Number.isFinite(duration) || duration <= 0)
        return false;
    // 只认小时（实测唯一形态）；其他单位不臆造换算。
    if (unit !== 'hour')
        return false;
    // 算术平移到 Asia/Shanghai（UTC+8）后取「当天已过分钟数」。
    const shanghaiMs = nowMs + 8 * 3600_000;
    const dayMinutes = Math.floor(shanghaiMs / 60_000) % (24 * 60);
    const startMinutes = hour * 60 + minute;
    const windowMinutes = duration * 60;
    // ⚠️ 窗口可以**跨日界**（21:00 + 11h → 次日 7:59）：取模处理。
    const offset = (dayMinutes - startMinutes + 24 * 60) % (24 * 60);
    return offset < windowMinutes;
}
/** 从 JSON 响应中沿路径指针取数组。 */
function extractJsonArray(text, path) {
    try {
        let value = JSON.parse(text);
        for (const key of path) {
            if (typeof value !== 'object' || value === null)
                return undefined;
            value = value[key];
        }
        return Array.isArray(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 签名 GET 请求远端端点并读取文本；网络失败或非 200 时返回 undefined
 * （不阻断调用方）。
 */
async function fetchSignedGet(fetcher, url, ak, sk, st, 
/** 签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）。 */
extraUnsignedHeaders) {
    const signed = await signRequestHuawei(ak, sk, st, 'GET', url, new Uint8Array());
    const headers = new Headers();
    signed.forEach((v, k) => {
        if (k !== 'host')
            headers.set(k, v);
    });
    if (extraUnsignedHeaders !== undefined) {
        for (const [k, v] of Object.entries(extraUnsignedHeaders))
            headers.set(k, v);
    }
    try {
        const response = await fetcher(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok)
            return undefined;
        return await response.text();
    }
    catch {
        return undefined;
    }
}
/**
 * 从两个远端端点拉取模型列表并合并去重：
 * 1. opengw gateway/config → result.models（benefit 模型）
 * 2. snap-access /v1/model/builtin → builtinModels（常规模型）
 * 失败或空凭据时返回空数组（不阻断）。
 *
 * 同时把 gateway/config 下发的 benefit 模型 id 集合写入独立缓存
 * （见 {@link saveBenefitCache}），供 chat 请求判定是否带 `maas_type: benefit`。
 */
export async function fetchCodeArtsRemoteModels(credential, fetcher = fetch, 
/**
 * 各来源成败的**出参**（issue IKJVTF，审计 I3）。
 *
 * ⚠️ 用出参而非改返回值：本函数的既有调用方与 10 条单测都按「返回数组」用，
 * 改形状会波及它们；而完整性只对**适配器**有意义（它决定要不要永久缓存）。
 * 不传即不关心完整性，行为逐字节不变。
 */
outcome, 
/**
 * 「现在」的时刻（毫秒）—— **只为倍率选时段**用。
 *
 * ⚠️ 加它是因为倍率**随时间变**（`deepseek-v4.1-flash` 错峰档 21:00–次日 7:59
 * 显示 0.09x，其余时段 0.18x）。单测必须能注入时刻，否则「是否落在错峰窗口」
 * 这条逻辑无法被确定性覆盖。缺省 `Date.now()` ⇒ 生产行为不变。
 */
nowMs = Date.now()) {
    const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential;
    if (!ak || !sk) {
        // 无凭据时**两个来源都没取到** —— 不能默认成 true（否则残缺被判成完整）。
        if (outcome !== undefined) {
            outcome.gatewayOk = false;
            outcome.builtinOk = false;
        }
        return [];
    }
    const models = [];
    const seen = new Set();
    // 来自 gateway/config 的 benefit 模型 id —— 调用时必须带 maas_type: benefit。
    //
    // ⚠️ 只记录**未被去掉日期后缀**的 id（即 chat 请求真正发出的那个 id）。
    // 原因：normalizeModelId 会把 gateway 的 `deepseek-v4-flash-0731` 改写成
    // `deepseek-v4-flash`，而两者在后端是**不同模型**、benefit 属性相反
    // （实测：`-0731` 不带 maas_type → 404；无后缀的不带 → 成功、带上 →
    // `unsupported model`）。记录被改写过的 id 会把无后缀模型错误标记为
    // benefit，导致它反而调用失败。既然该 id 我们根本不发送，它也就无从
    // 决定我们发送的 id 的 benefit 属性。
    const benefitIds = [];
    // 1. opengw gateway/config — benefit 模型（glm-5.3-flash 等）
    //
    // ⚠️ 成功判据是「**请求成功且形状可识别**」，不是「解析出非空列表」：
    // 上游把 benefit 模型全部下架时 `result.models: []` 是**合法**状态，
    // 把它当失败会让冷却永不清理（与 Cline 的 `isClineRecommendedShape` 同口径）。
    const gatewayText = await fetchSignedGet(fetcher, OPENGW_GATEWAY_CONFIG_URL, ak, sk, st);
    const gatewayArr = gatewayText === undefined
        ? undefined
        : extractJsonArray(gatewayText, ['result', 'models']);
    if (outcome !== undefined)
        outcome.gatewayOk = gatewayArr !== undefined;
    if (gatewayArr !== undefined) {
        for (const item of gatewayArr) {
            if (typeof item === 'object' && item !== null) {
                const entry = item;
                const rawId = typeof entry['model_id'] === 'string' ? entry['model_id'] : '';
                const mi = parseModelInfo(entry, seen, nowMs);
                if (mi) {
                    // 仅当归一化未改写 id 时才记为 benefit（见上方说明）
                    if (rawId.length > 0 && normalizeModelId(rawId) === rawId)
                        benefitIds.push(mi.id);
                    models.push(mi);
                }
            }
        }
    }
    // 2. snap-access /v1/model/builtin — 常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）
    //    Agent-Type: PromptCenter + X-Language: zh-cn（不参与签名）。
    //    替代旧 statistics/plugin（已不再返回 model_metrics）。
    const snapText = await fetchSignedGet(fetcher, SNAP_MODEL_BUILTIN_URL, ak, sk, st, {
        'Content-Type': 'application/json',
        'Agent-Type': 'PromptCenter',
        'X-Language': 'zh-cn',
    });
    const snapArr = snapText === undefined
        ? undefined
        : extractJsonArray(snapText, ['builtinModels']);
    if (outcome !== undefined)
        outcome.builtinOk = snapArr !== undefined;
    if (snapArr !== undefined) {
        for (const item of snapArr) {
            if (typeof item === 'object' && item !== null) {
                const mi = parseModelInfo(item, seen, nowMs);
                if (mi)
                    models.push(mi);
            }
        }
    }
    // 持久化 benefit 集合：chat 请求签名时据此决定是否带 maas_type。
    // 仅在确实从 gateway 拿到模型时写入，避免把空集合覆盖掉可用缓存。
    if (benefitIds.length > 0) {
        setBenefitMemoryCache(benefitIds);
        saveBenefitCache(benefitIds);
    }
    return models;
}
/**
 * 缓存目录：默认 `~/.cache/deveco`，可用 `DSH_CODEARTS_CACHE_DIR` 覆盖
 * （单测借此隔离，避免污染真实用户缓存）。
 */
function cacheDir() {
    const override = process.env.DSH_CODEARTS_CACHE_DIR;
    if (override !== undefined && override.length > 0)
        return override;
    const home = process.env.USERPROFILE ?? process.env.HOME;
    if (!home)
        return undefined;
    return `${home}/.cache/deveco`;
}
/** 动态模型列表缓存路径：~/.cache/deveco/codearts_models.json。 */
function modelsCachePath() {
    const dir = cacheDir();
    return dir === undefined ? undefined : `${dir}/${CODEARTS_MODELS_CACHE_FILENAME}`;
}
/** benefit 模型集合缓存路径：~/.cache/deveco/codearts_benefit_models.json。 */
function benefitCachePath() {
    const dir = cacheDir();
    return dir === undefined ? undefined : `${dir}/${CODEARTS_BENEFIT_CACHE_FILENAME}`;
}
/**
 * 保存动态模型列表到缓存文件（原子写入 tmp+rename）。
 *
 * ⚠️ 必须用**顶层静态导入**的 `node:fs`（见文件头），**不能**用
 * `require('node:fs')`：本包是 ESM（package.json `"type": "module"`），
 * `require` 在 ESM 下未定义，调用会抛 ReferenceError —— 被下面的 catch
 * 静默吞掉，表现为「写入/读取永远无效」。真实缺陷（2026-09-23）：磁盘缓存
 * 的读取路径曾因 `require` 恒返回 undefined，于是模型列表与 benefit 集合
 * 每次都要回退静态兜底。
 */
export function saveModelsCache(models) {
    const path = modelsCachePath();
    if (!path)
        return;
    const dir = path.slice(0, path.lastIndexOf('/'));
    try {
        mkdirSync(dir, { recursive: true });
        const tmp = path + '.tmp';
        writeFileSync(tmp, JSON.stringify(models), 'utf-8');
        renameSync(tmp, path);
    }
    catch {
        // 写入失败静默忽略
    }
}
/** 加载缓存文件中的动态模型列表; 文件不存在或解析失败时返回 undefined。 */
export function loadModelsCache() {
    const path = modelsCachePath();
    if (!path)
        return undefined;
    try {
        if (!existsSync(path))
            return undefined;
        const text = readFileSync(path, 'utf-8');
        const models = JSON.parse(text);
        return Array.isArray(models) && models.length > 0 ? models : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 取出可用模型列表，优先级：内存缓存 → 磁盘缓存 → 空。
 * 由 adapter 的 listModels 调用；无远端模型时仍回退到 adapter 的静态默认列表。
 */
export function availableCodeArtsModels() {
    if (memoryCache !== undefined)
        return memoryCache;
    const disk = loadModelsCache();
    if (disk !== undefined) {
        memoryCache = disk;
        return disk;
    }
    return undefined;
}
/** 设置内存缓存（由 service 拉取成功后调用）。 */
export function setMemoryCache(models) {
    memoryCache = models;
}
/**
 * 保存 benefit 模型 id 集合到缓存文件（原子写入 tmp+rename）。
 * 文件不存在或写入失败时静默忽略 —— 判定会回退到静态兜底集合。
 *
 * 同步写入（与 {@link loadBenefitCache} 一致）：chat 请求签名前要读它，
 * 异步写入会让「刚拉取完就发消息」的窗口期内读到旧值/空值。
 */
export function saveBenefitCache(ids) {
    const path = benefitCachePath();
    if (!path)
        return;
    const dir = path.slice(0, path.lastIndexOf('/'));
    try {
        mkdirSync(dir, { recursive: true });
        const tmp = path + '.tmp';
        writeFileSync(tmp, JSON.stringify(ids), 'utf-8');
        renameSync(tmp, path);
    }
    catch {
        // 写入失败静默忽略
    }
}
/** 加载缓存文件中的 benefit 模型 id 集合；文件不存在或解析失败时返回 undefined。 */
export function loadBenefitCache() {
    const path = benefitCachePath();
    if (!path)
        return undefined;
    try {
        if (!existsSync(path))
            return undefined;
        const text = readFileSync(path, 'utf-8');
        const ids = JSON.parse(text);
        if (!Array.isArray(ids) || ids.length === 0)
            return undefined;
        return ids.filter((id) => typeof id === 'string');
    }
    catch {
        return undefined;
    }
}
/** 设置 benefit 集合内存缓存（由远端拉取成功后调用；undefined 表示清除）。 */
export function setBenefitMemoryCache(ids) {
    benefitMemoryCache = ids;
}
/**
 * 判断某模型是否为 benefit（免费额度）模型 —— 决定 chat 请求是否必须带
 * `maas_type: benefit`。
 *
 * 优先级：内存缓存 → 磁盘缓存（远端拉取所得）→ 静态兜底集合。
 * 远端集合优先，使后端新增 benefit 模型时**无需改代码**即可自动识别。
 *
 * ⚠️ 判定**不是**「名字里带 flash」这类猜测：`deepseek-v4-flash`（无后缀）
 * 与 `glm-5.3-flash` 名字形态相同，benefit 属性却相反。唯一权威来源是
 * gateway/config 的模型清单 + 兜底表。
 */
export function isCodeArtsBenefitModel(model) {
    if (benefitMemoryCache === undefined)
        benefitMemoryCache = loadBenefitCache();
    if (benefitMemoryCache !== undefined && benefitMemoryCache.includes(model))
        return true;
    return CODEARTS_BENEFIT_FALLBACK.includes(model);
}
//# sourceMappingURL=models.js.map