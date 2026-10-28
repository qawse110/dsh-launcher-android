/**
 * 冷启动的**有界目录预热**（issue IKJVTF）。
 *
 * ## 为什么需要它
 *
 * 冷启动时凭据可能还没就绪、或本机到目录端点的**首次**连接不稳定 ——
 * 首拉失败后 `remoteModels` 保持 `undefined`，适配器回落到**静态兜底表**。
 * 此后：
 *
 * - 客户端 `ModelCatalogDirectory` 把这份**兜底目录**缓存成 `status: 'ready'`
 *   （它只认宿主事件，见 `catalog-broadcast.ts`）；
 * - 适配器侧虽有闸门冷却，但**没有任何东西会在冷却到期后再试一次** ——
 *   只有用户主动操作（打开设置页、切换模型）才可能触发下一次 `listModels`。
 *
 * 于是「远端目录其实早就拿到了，只是没人再问一次」会一直持续到用户碰巧
 * 触发重读为止。本模块补的就是这条**自愈**路径。
 *
 * ## 为什么是「有界」而不是定时轮询
 *
 * 目录是**启动期**问题：稳态下 `remoteModels` 已落地，各适配器在
 * `remoteModels !== undefined` 处直接短路，预热调用是零成本的本地判断。
 * 但若做成无限轮询，一个**真的**拿不到目录的 provider（未登录 / 上游长期故障）
 * 会被每 30 秒唤醒一次，永远打无谓请求。故只排固定的几轮就停手。
 *
 * ## ⚠️ 间隔必须大于闸门的失败冷却
 *
 * `RemoteCatalogGate` 失败后冷却 {@link REMOTE_CATALOG_COOLDOWN_MS}（30 秒）。
 * 若预热间隔**小于**它，重试会被闸门**原样挡回**、什么也不做 ——
 * 那等于没有预热。故默认间隔是 35s（> 30，留 5 秒余量）。
 *
 * ⚠️ **光有「间隔 > 冷却」还不够**（对抗审计实测证伪）：闸门的 `retryAt` 是
 * 「**失败那一刻** + 30s」，而固定排程是「**启动那一刻** + 35s / 75s」——
 * 首拉耗时 `d` 落在 `(5s, 35s]` 时 35s 轮被挡回，落在 `(45s, 75s]` 时 75s 轮
 * 也被挡回（`d=60s` 实测：`retryAt=90s`，75s 轮时仍在冷却）。
 * ⇒ 排程改为**链式**（上一轮**结束**后再排下一轮），见 `runChain`。
 *
 * 这条约束由 `tests/unit/catalog-prewarm.spec.ts` 用
 * `isPrewarmSpacingValid()` 直接守着 —— 谁把间隔改小，那条用例就变红。
 */
import { REMOTE_CATALOG_COOLDOWN_MS } from './remote-catalog-gate.js';
/**
 * 预热轮次的间隔（毫秒，**相对上一轮结束**，见 `runChain`）。
 *
 * - `0` —— 首次立即执行（凭据往往已就绪，能一把拿到目录）；
 * - `35_000` / `75_000` —— 两段补拉间隔，覆盖「首拉时凭据未就绪 / 网络抖动」。
 *
 * ⚠️ 非零项必须**大于** {@link REMOTE_CATALOG_COOLDOWN_MS}，否则被闸门挡回。
 */
export const CATALOG_PREWARM_DELAYS_MS = [0, 35_000, 75_000];
/** 默认定时器：`setTimeout` + 返回取消函数。 */
function defaultSchedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
}
/**
 * 启动有界预热，返回**停止函数**（须挂到 `ctx.effect` 上）。
 *
 * 每轮对每个 provider 各调一次 {@link CatalogPrewarmOptions.warm}。
 * 单个 provider 失败**不影响**其余（`Promise.allSettled` 语义）——
 * 一个未登录的 provider 不该让其它 provider 的预热一起消失。
 */
export function startCatalogPrewarm(options) {
    const delays = options.delaysMs ?? CATALOG_PREWARM_DELAYS_MS;
    const schedule = options.schedule ?? defaultSchedule;
    let stopped = false;
    const cancels = [];
    /** 跑一轮：逐 provider 触发读取，全部失败都只记日志。 */
    const runRound = async () => {
        // 逐 provider 独立等待，避免一个 provider 的慢请求拖住其余
        // （它们本就互不依赖，且各自的闸门负责去重与冷却）。
        await Promise.allSettled(options.providers.map(async (provider) => {
            try {
                await options.warm(provider);
            }
            catch (error) {
                options.logger?.warn?.(`[jet-hub] 目录预热失败（${provider}）：${error instanceof Error ? error.message : String(error)}`);
            }
        }));
    };
    /**
     * 按 {@link CatalogPrewarmOptions.delaysMs} 依次跑，**每轮结束再排下一轮**。
     *
     * ## ⚠️ 为什么不是「一次性把三轮都排上」（真实缺陷，对抗审计实测证伪）
     *
     * 闸门的失败冷却 `retryAt` 是「**失败那一刻** + 30s」，而固定排程是
     * 「**启动那一刻** + 35s / 75s」。两者错位时重试会被闸门**原样挡回**：
     *
     * | 首拉耗时 d | 35s 轮 | 75s 轮 |
     * |---|---|---|
     * | 6s（cline 超时 20s 之内） | **白费** | 有效 |
     * | 60s（buddy/loomy/raccoon 超时） | **白费** | **白费** |
     *
     * 实测：`d=60s` 时 `retryAt = 60s+30s = 90s`，而 75s 轮在 `t=75s` 时
     * `cooling()` 仍为真 ⇒ 那一轮什么也不做。
     *
     * ⇒ 改成**链式**：`上一轮结束 + 间隔` 才排下一轮。间隔本身仍严格大于冷却，
     * 故只要上一轮真的尝试过（哪怕失败），下一轮必然已越过冷却窗口。
     *
     * ⚠️ `delaysMs` 的语义随之变为「**轮次之间的间隔**」，其**首项**是首次延迟
     *（`0` = 立即）。`CATALOG_PREWARM_DELAYS_MS = [0, 35_000, 75_000]` 于是表示
     *「立即跑一轮，此后每隔 35s 再跑，共三轮」—— 对用户而言「共三轮」这个
     * **有界**语义不变（这是本模块的设计前提：不做无限轮询）。
     */
    const runChain = async (index) => {
        if (stopped)
            return;
        if (index >= delays.length)
            return;
        await runRound();
        if (stopped)
            return;
        const next = delays[index + 1];
        if (next === undefined)
            return;
        // 间隔取 `next` 自身（`[0, 35_000, 75_000]` ⇒ 两段各 35s / 75s）。
        // 首项 `0` 只表示「立即」，不参与间隔；万一有人把首项写成非 0，
        // 用它当间隔也仍是「大于冷却」的合法值。
        const gap = next > 0 ? next : REMOTE_CATALOG_COOLDOWN_MS + 1;
        cancels.push(schedule(() => {
            void runChain(index + 1);
        }, gap));
    };
    // 立即那一轮：**排到 microtask**，不在调用栈内触达 `warm`。
    // `apply()` 是同步函数，而 `warm` 会发起网络请求 —— 同步调用它等于把
    // 首个请求塞进插件启动路径（与既有的 opencode 能力预热同款约定）。
    queueMicrotask(() => {
        if (stopped)
            return;
        void runChain(0);
    });
    return () => {
        stopped = true;
        for (const cancel of cancels)
            cancel();
        cancels.length = 0;
    };
}
/**
 * 预热间隔是否满足「大于闸门冷却」这条硬约束。
 *
 * 抽成函数是为了让**接线层**也能断言（不止单测）：间隔小于冷却时预热等于没做，
 * 且症状是「静默无效」（没有任何报错，只是目录一直补不回来）。
 */
export function isPrewarmSpacingValid(delays = CATALOG_PREWARM_DELAYS_MS) {
    // 只看**非零**的那些：立即那一轮（0）不受冷却约束。
    return delays.filter((delay) => delay > 0).every((delay) => delay > REMOTE_CATALOG_COOLDOWN_MS);
}
//# sourceMappingURL=catalog-prewarm.js.map