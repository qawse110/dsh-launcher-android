/**
 * 带 **TTL** 与**在飞去重**的小缓存。
 *
 * ## 为什么需要（对齐官方 ZCode，2026-10-01）
 *
 * 官方闭源版渲染层产物里的 `f3()`（`out/renderer/assets/styles-*.js`）：
 *
 * ```js
 * let u3 = null, d3 = null
 * async function f3(e) {
 *   const t = Date.now()
 *   if (u3 && u3.expiresAt > t) return u3.value      // ← 命中缓存
 *   if (d3) return d3                                // ← 在飞去重
 *   d3 = (async () => { … u3 = { value: n ?? null, expiresAt: t + 6e4 } … })()
 *         .finally(() => { d3 = null })
 *   return d3
 * }
 * ```
 *
 * 两个语义都对得上我们的需求：
 * - **TTL 60 秒**（`t + 6e4`）：captcha **配置**（region/prefix/sceneId）极少变，
 *   但也不该永久缓存 —— 服务端改动后要能自愈。
 * - **在飞去重**：并发请求只发一次底层调用。
 *
 * ## 与 `index.ts` 现有实现的关键差异（真实缺陷）
 *
 * 现状是 `zcodeCaptchaConfigPromise ??= (async () => …)()` —— 那是**永久缓存**：
 * 赋过一次就**再也不刷新**。后果是服务端换 `sceneId`／灰度切换后，进程必须
 * 重启才能跟上；而若第一次拉取恰好失败（网络抖动），`??=` 会把**失败结果**
 * 也一起记住（下面 `fetchZcodeCaptchaConfig` 失败返回 `undefined`，
 * 而调用方回退到兜底值 —— 那个兜底值同样会被永久固化）。
 */
/**
 * 单个值的 TTL 缓存 + 在飞去重。
 *
 * ⚠ **失败不缓存**：`load()` 抛错时清掉在飞标记并**向上抛** ——
 * 让调用方自己决定回退（例如 captcha 配置回退到兜底值），
 * 而**不要把失败固化**（那正是现状 `??=` 的缺陷）。
 */
export class TtlCache {
    entry;
    inflight;
    ttlMs;
    ttlFor;
    load;
    now;
    constructor(options) {
        this.ttlMs = options.ttlMs;
        this.ttlFor = options.ttlFor;
        this.load = options.load;
        this.now = options.now ?? (() => Date.now());
    }
    /**
     * 取缓存值；过期则重新加载。
     *
     * @param options.force - 强制绕过缓存重新加载（用于「服务端拒绝后刷新配置」）。
     */
    async get(options = {}) {
        if (options.force !== true) {
            const hit = this.peek();
            if (hit !== undefined)
                return hit.value;
        }
        // 在飞去重：并发调用共用同一次 load（官方 `d3` 的同款语义）。
        if (this.inflight !== undefined)
            return await this.inflight;
        const task = (async () => {
            const value = await this.load();
            this.write(value);
            return value;
        })();
        this.inflight = task;
        try {
            return await task;
        }
        finally {
            // ⚠ 无条件清在飞标记 —— 抛错时也要清，否则下一次永远复用一个已 rejected 的 promise。
            this.inflight = undefined;
        }
    }
    /**
     * 只看缓存（**不触发加载**）。过期返回 `undefined` 并顺手丢弃。
     *
     * 诊断与单测用；`get()` 内部也走它，避免两处 TTL 判据漂移。
     */
    peek() {
        const entry = this.entry;
        if (entry === undefined)
            return undefined;
        // ⚠ 用**这一条自己的** ttlMs（写入时由 `ttlFor` 定下），不是构造参数 ——
        // 否则「成功缓存久 / 失败缓存短」会在读取这一侧被构造参数覆盖掉。
        if (this.now() - entry.atMs >= entry.ttlMs) {
            this.entry = undefined;
            return undefined;
        }
        return entry;
    }
    /** 写入一个已知值（例如从别处拿到的新配置，避免下一次白加载）。 */
    set(value) {
        this.write(value);
    }
    /** 写入缓存项：有效期在**这一刻**定下（见 `TtlCacheOptions.ttlFor`）。 */
    write(value) {
        this.entry = { value, atMs: this.now(), ttlMs: this.effectiveTtl(value) };
    }
    /** 这一条该缓存多久；`ttlFor` 缺省或返回非法值时用构造参数。 */
    effectiveTtl(value) {
        if (this.ttlFor === undefined)
            return this.ttlMs;
        const ttl = this.ttlFor(value);
        return Number.isFinite(ttl) && ttl >= 0 ? ttl : this.ttlMs;
    }
    /** 清空（关停时调用）。 */
    clear() {
        this.entry = undefined;
        this.inflight = undefined;
    }
}
//# sourceMappingURL=ttl-cache.js.map