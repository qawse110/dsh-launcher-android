/** 在凭据过期前提前这么长时间触发刷新（1 小时；对齐真实插件的 36e5）。 */
export const REFRESH_LEAD_MS = 3_600_000;
/** 普通刷新失败后的重试间隔（10 分钟；对齐 RENEW_TOKEN_INTERVAL_WHEN_LAST_TIME_FAILED）。 */
export const REFRESH_RETRY_MS = 600_000;
/** 异常网络（fetch failed 等）后的重试间隔（1 分钟；对齐 …_BY_ABNORMAL_NETWORK）。 */
export const REFRESH_ABNORMAL_NETWORK_RETRY_MS = 60_000;
/** 判定是否为「异常网络」类错误（对齐真实插件的 isAbnormalNetwork）。 */
function isAbnormalNetworkError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /fetch failed|ENOTFOUND|ECONNREFUSED|proxy|unresolved host|getaddrinfo/i.test(message);
}
/**
 * 「连不上」与「连上了但失败」必须分开（Gitee issue IKLTZ2）。
 *
 * ⚠️ `fetch failed` 是 undici 把**所有**传输层失败压成的同一句话，真因只在
 * `cause` 上。`isAbnormalNetworkError` 把它（连同 `ENOTFOUND` /
 * `ECONNREFUSED`）一律归成「1 分钟后重试的瞬时抖动」—— 对真正的抖动是对的，
 * 但对**「墙外服务根本出不去」**是错的：那不是抖动，60 秒后再试还是同样的
 * 超时，于是调度器**永远静默重试**，面板上零线索（issue 原话：「面板上完全
 * 看不出是网络/代理原因，用户只能看到授权失败」）。
 *
 * ⚠️ 为什么是「拉长间隔」而不是「停止调度」：连接超时**可能**是临时的
 * （用户正在切代理 / 代理刚启动）⇒ 保留重试但从 1 分钟拉到 30 分钟。
 * **刻意不归终态**（`RefreshTokenExpiredError` 那种停调度）：凭据没坏，
 * 代理一恢复就该自动复活。
 *
 * ⚠️ 判据读 `cause` 链上的**错误码**（`UND_ERR_*` / `EHOSTUNREACH` …）而不是
 * message：`message` 恒为 `fetch failed`，用它判会把**所有**传输失败
 * （含 5xx 之后的读体失败）都拉长间隔。
 */
export function isUnreachableNetworkError(error) {
    // 遍历上限防病态自引用链（与 `opencode-rpc.ts` 的 `describeFetchError` 同款）。
    let current = error;
    for (let i = 0; i < 8 && current !== null && current !== undefined; i += 1) {
        const code = current.code;
        if (typeof code === 'string'
            && /UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i.test(code)) {
            return true;
        }
        current = current.cause;
    }
    return false;
}
/**
 * 判定 refresh_token 是否已失效（终态：停止调度并提示重新登录）。
 *
 * 结构化判定而非 instanceof：CodeArts（oauth.ts）与 Buddy（buddy-oauth.ts）
 * 各自导出同名 `RefreshTokenExpiredError`，跨模块 identity 不同，
 * 用 instanceof 会让其中一个 provider 的失效信号穿透为「可重试」而无限重试。
 */
function isRefreshTokenExpired(error) {
    if (!(error instanceof Error))
        return false;
    if (error.name === 'RefreshTokenExpiredError')
        return true;
    return /refresh[_ ]?token/i.test(error.message);
}
/**
 * 计算首次刷新触发前的毫秒数（对齐真实插件 getFirstRefreshTime）：
 * - 无有效过期时间或距过期 ≤1h → 0（立即刷新）；
 * - 否则触发点 = now + 1h，再叠加 0-59 秒随机偏移。
 */
export function computeFirstRefreshDelayMs(expiresAtMs, nowMs = Date.now()) {
    if (!Number.isFinite(expiresAtMs))
        return 0;
    const leadTrigger = nowMs + REFRESH_LEAD_MS;
    if (leadTrigger >= expiresAtMs)
        return 0;
    const trigger = new Date(leadTrigger);
    trigger.setSeconds(Math.floor(60 * Math.random()));
    const delay = trigger.getTime() - nowMs;
    return delay > 0 ? delay : 0;
}
/** 静默刷新调度器：一次触发 + 失败重试（失效则停止）。 */
export class RefreshScheduler {
    refresh;
    onError;
    timer;
    pending = false;
    /** 调度代号：stop()/arm() 都会推进它，用于让在途 run() 放弃失败后的重试武装。 */
    generation = 0;
    constructor(refresh, onError = () => { }) {
        this.refresh = refresh;
        this.onError = onError;
    }
    /** 为在 `expiresAtMs` 过期的凭据安排下次刷新；`nowMs` 仅供测试注入。 */
    arm(expiresAtMs, nowMs = Date.now()) {
        // 先推进代号：使任何在途 run() 的失败路径放弃重试，并隔离旧定时器。
        this.generation++;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const delay = computeFirstRefreshDelayMs(expiresAtMs, nowMs);
        this.timer = setTimeout(() => {
            void this.run();
        }, delay);
        this.timer.unref?.();
    }
    /** 取消任何待处理的刷新（并让在途 run() 失败后不再重试）。 */
    stop() {
        // 先推进代号：登出场景下取消在途刷新失败后的重试武装。
        this.generation++;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    /** 立即执行一次刷新（供启动时已处于到期窗口内的凭据使用）。 */
    async refreshOnce() {
        this.stop();
        await this.run();
    }
    async run() {
        if (this.pending)
            return;
        this.pending = true;
        const generation = this.generation;
        try {
            await this.refresh();
        }
        catch (error) {
            this.onError(error);
            if (generation !== this.generation) {
                // 在途期间被 stop()/arm() 打断：放弃本次失败后的重试，避免登出后调度器复活。
                return;
            }
            if (isRefreshTokenExpired(error)) {
                // refresh_token 已失效（终态）：停止调度，提示重新登录。
                return;
            }
            // 在途期间可能已新 arm()（this.timer 已指向新定时器 T2）：先清除，避免覆盖后 T2 沦为孤儿定时器。
            if (this.timer !== undefined) {
                clearTimeout(this.timer);
            }
            // ⚠️⚠️ **刻意只有两格**：原提交在这里加了第三格
            //（`isUnreachableNetworkError ? REFRESH_UNREACHABLE_RETRY_MS`），
            // 而它是**净损害**，独立审计实测确认了两个原因：
            //
            // 1. **对 gemini 自身零作用** —— gemini **不使用** `RefreshScheduler`
            //    （全仓 7 处 `new RefreshScheduler` 在 buddy / workbuddy / cline /
            //    qoder / trae / lobsterai / autoclaw，**gemini-auth.ts 没有**）。
            //    gemini 走账号池 `refreshAll`，由 `MultiAccountRefreshScheduler`
            //    驱动，那里的间隔是**固定 30 分钟**、**没有任何错误分类** ⇒
            //    「1 分钟 → 30 分钟」这层改动对 gemini 一行都不生效（它本来就是
            //    30 分钟），commit message 的说法与实现不符。
            // 2. **误伤了另外七个 provider** —— 它们与墙无关，把一次 DNS 抖动
            //    （`ENOTFOUND`，典型的临时故障）从 60 秒拉长到 30 分钟，
            //    代价是「代理抽风一次，用户 30 分钟不能用」。
            //
            // ⇒ 「连不上」这个判据**仍然有用**（它被 `geminiNetworkHint` 用于给出
            //   指路文案，见 `src/gemini-proxy.ts`），但**重试间隔**不该动：
            //   静默重试 60 秒一次不伤任何人，而拉长间隔才是净损失。
            //   若将来 gemini 真要独立的退避策略，该加在
            //   `MultiAccountRefreshScheduler` 上（它目前无错误分类能力），而不是
            //   在这条**七家共享**的链上动。
            const retry = isAbnormalNetworkError(error) ? REFRESH_ABNORMAL_NETWORK_RETRY_MS : REFRESH_RETRY_MS;
            this.timer = setTimeout(() => {
                void this.run();
            }, retry);
            this.timer.unref?.();
        }
        finally {
            this.pending = false;
        }
    }
}
//# sourceMappingURL=refresh.js.map