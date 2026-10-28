/**
 * captcha 产出的**失败退避**（吸收自 `dsh-free-glm` 的 `noteMintFailure`）。
 *
 * ## 为什么必须有（真实缺陷，2026-10-01，来自会话实证）
 *
 * `session-eced01ed`（provider=`zcode`，我方插件）里，额度耗尽后有 **12 次**
 * 空响应失败（6 次请求 × 2 个 turn）——而**每一次重试都重新 mint 了一个 captcha**。
 * 也就是说：在额度已经用完、请求注定失败的情况下，我们白耗了 12 个 captcha 配额。
 *
 * 这有两个后果，第二个更严重：
 *
 * 1. **白等**：harness 的退避 491ms→1087ms→1907ms→3633ms→7256ms ≈ **14.4 秒**，
 *    而这 14.4 秒**不可能成功**（额度当天不会恢复）。
 * 2. ★ **加速信誉恶化**：阿里云 captcha 有**设备信誉**概念，失败会扣信誉。
 *    同一分钟里另一个 session（`session-b0e4eb3f`，provider=`zcode-bridge`）
 *    报的是 `502 Failed to mint auth material` —— 两个插件在同一台设备上
 *    互相抢同一份信誉（证据：两个 session 时间戳相差约 1 分钟）。
 *
 * ## 那边的做法与实测依据
 *
 * `dsh-free-glm/patches/zcodeBridgeServer.ts` 的 `noteMintFailure()` /
 * `mintBackoffRemainingMs()`（L1310-1355）：连续失败达阈值后进入**指数冷却**，
 * 期间**直接返回 503 + `Retry-After`**，而不是继续发起 mint。
 * 那边的注释原话：**「继续请求不会让信誉恢复，只会更糟」**。
 *
 * ## 本实现的两个关键设计
 *
 * ### 1. 阈值 3 次，冷却 1 分钟起步、翻倍、上限 30 分钟
 *
 * 沿用那边的取值（它是在**同一个上游**上实测出来的）。
 *
 * ### 2. 只对「**产出失败**」计数，不对「上游拒绝 param」计数
 *
 * 这是与那边的一个**有意差异**：`mintOnPage` 抛错（SDK `F001` / 超时 /
 * 降级产物）说明**本机产出能力**出了问题，继续试只会更糟 → 计数。
 * 而「mint 成功但上游回 `3007`」说明 param 本身可能没问题（也可能真有问题），
 * 归因不清 → **不计数**（避免把服务端的临时抖动记成我们的信誉问题）。
 *
 * ## 与预取池的关系
 *
 * ⚠ 退避期间**预取也要停**：`zcode-auth.ts` 的 `mintCaptcha` 会在
 * 退避中直接抛错，池的 `prefetch()` 捕获后只记日志 —— 也就是自然不产。
 * 这一点由「池的 mint 回调走同一个 `mintCaptcha`」保证，不需要池自己判断。
 */
/**
 * **冷却闸门错误**：因处于退避冷却期而**直接拒绝**，本次根本没有发起 mint。
 *
 * ## ⚠️⚠️ 为什么必须单独可判别（对抗审计实测的 P0，IKQ4JN 附带修）
 *
 * 冷却闸门抛普通 `Error` 时，它会**流回调用侧那个「记一次失败」的 catch**
 * （闸门在 `ZcodeCaptchaBrowser` 内部，而 catch 包住整个 `mintWithOutcome`）
 * ⇒ 每点一次就 `noteFailure()` 一次 ⇒ `streak` 单调增长、冷却**指数放大**。
 *
 * 实测（`threshold=3, base=60s, max=30min`）：
 *
 * ```
 * 真失败 3 次 ⇒ 冷却 60s, streak=3
 * 冷却期内再点 5 次 ⇒ streak 4→8，冷却 60s → 120 → 240 → 480 → 960 → 1800s
 * ```
 *
 * ⇒ **用户多点几次操作，就把 1 分钟冷静期推成 30 分钟**，而他什么也没做错
 * （那 5 次请求一次都没发出去，**没有伤到任何设备信誉**）。
 *
 * ## 判据
 *
 * 闸门拒绝 = 「本次没有 mint」⇒ **不得**计入 streak（与部署错误同一条理由：
 * 没有发出请求就没有信誉可伤）。这与「冷却期内继续尝试」无关 ——
 * 闸门本来就该拒绝，只是不该**因为被拒绝**而加重处罚。
 *
 * ⚠️ 它**不是**部署错误：冷却可能是真信誉问题导致的，文案仍应保持
 * 「稍后再试 + 若从未成功过则去装浏览器」的双出口（见调用点）。
 */
export class CaptchaCooldownError extends Error {
    remainMs;
    constructor(message, remainMs) {
        super(message);
        this.remainMs = remainMs;
        this.name = 'CaptchaCooldownError';
    }
}
/**
 * 该错误是否只是「冷却期拒绝」（⇒ **不**再计入退避，否则冷却会自我放大）。
 *
 * ⚠️ 与 `isBrowserDeploymentError`（`chromium-session.ts`）一样用 `name` + 字段双判
 * （对模块副本免疫）。
 */
export function isCaptchaCooldownError(error) {
    if (typeof error !== 'object' || error === null)
        return false;
    const record = error;
    return record.name === 'CaptchaCooldownError' && typeof record.remainMs === 'number';
}
/**
 * captcha 产出失败计数器与冷却闸门。
 *
 * 有状态：每个 provider 实例持有一个即可（captcha 的产出能力是**设备级**的，
 * 与账号、模型都无关）。
 */
export class CaptchaBackoff {
    threshold;
    baseMs;
    maxMs;
    enabled;
    now;
    /** 连续失败次数（成功即清零）。 */
    streak = 0;
    /** 冷却截止时刻（毫秒；0 = 不在冷却中）。 */
    untilMs = 0;
    constructor(options = {}) {
        this.threshold = options.threshold ?? 3;
        this.baseMs = options.baseMs ?? 60_000;
        this.maxMs = options.maxMs ?? 30 * 60_000;
        this.enabled = options.enabled ?? true;
        this.now = options.now ?? (() => Date.now());
    }
    /** 当前连续失败次数（诊断用）。 */
    failureStreak() {
        return this.streak;
    }
    /**
     * 还要冷却多久（毫秒）。`0` = 不在冷却中，可以正常发起。
     *
     * ⚠ 到点后**自动清零冷却**（但**不**清 `streak` —— 连续失败次数要保留，
     * 否则一次到点就会让退避重新从 1 分钟起步，达不到「指数」的效果）。
     */
    remainingMs() {
        if (!this.enabled)
            return 0;
        const remain = this.untilMs - this.now();
        if (remain <= 0) {
            this.untilMs = 0;
            return 0;
        }
        return remain;
    }
    /** 记一次**产出成功**（清零连续失败与冷却）。 */
    noteSuccess() {
        this.streak = 0;
        this.untilMs = 0;
    }
    /**
     * 记一次**产出失败**；返回本次进入/延长的冷却截止时刻
     * （`0` = 还没到阈值，不需冷却）。
     */
    noteFailure() {
        if (!this.enabled)
            return 0;
        this.streak += 1;
        if (this.streak < this.threshold)
            return 0;
        /**
         * 指数增长：阈值那次是 `baseMs`，之后每多失败一次翻倍，直到上限。
         *
         * ⚠ 用 `streak - threshold` 而不是 `streak`：否则第 3 次失败就会
         * 直接等到 `base × 8`,首次冷却反而最久（与「起步 1 分钟」的语义相反）。
         */
        const steps = this.streak - this.threshold;
        const cooldown = Math.min(this.baseMs * 2 ** steps, this.maxMs);
        this.untilMs = this.now() + cooldown;
        return this.untilMs;
    }
    /** 清空状态（关停或用户手动重置）。 */
    reset() {
        this.streak = 0;
        this.untilMs = 0;
    }
}
/**
 * 从环境变量解析退避配置（生产入口用；单测直接构造 {@link CaptchaBackoff}）。
 *
 * ⚠ 与 `captchaPoolConfigFromEnv` 同款约定：**只认显式 `0` 为关闭**，
 * 空串/未设置 = 用默认值（而不是「假值即关闭」）。
 */
export function captchaBackoffConfigFromEnv(env = process.env) {
    const rawSwitch = env['DSH_ZCODE_CAPTCHA_BACKOFF'];
    const enabled = rawSwitch === undefined || rawSwitch.trim().length === 0
        ? true
        : rawSwitch.trim() !== '0';
    return { enabled };
}
/**
 * captcha **产出串行队列**是否启用（对齐官方的全局队列）。
 *
 * ⚠ 与同仓库其它开关一致：**只认显式 `0` 为关闭**。
 * **默认启用** —— 官方就是这么做的（`jnn`/`wnn` 的全局 promise 链），
 * 而并发产出会白耗阿里云的「同设备每小时 150 次」额度。
 */
export function captchaQueueEnabledFromEnv(env = process.env) {
    const raw = env['DSH_ZCODE_CAPTCHA_QUEUE'];
    return raw === undefined || raw.trim().length === 0 ? true : raw.trim() !== '0';
}
/**
 * captcha **配置缓存**的 TTL（毫秒）。默认 60 秒 —— **取官方同值**
 *（官方 `f3()` 里是 `expiresAt: t + 6e4`）。
 */
export const CAPTCHA_CONFIG_TTL_MS = 60_000;
//# sourceMappingURL=captcha-backoff.js.map