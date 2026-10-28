/**
 * Gemini 链路的**代理感知 fetcher**（Gitee issue IKLTZ2）。
 *
 * ## 缺陷背景
 *
 * Gemini（Cloud Code Assist）是本插件里**少数必须过墙**的渠道：令牌端点
 * （`oauth2.googleapis.com/token`）、userinfo、Cloud Code 的 `loadCodeAssist` /
 * `retrieveQuotaSummary` 与推理端点（`cloudcode-pa.googleapis.com`）全部在墙外。
 * 而本插件此前全链路用**裸 `fetch`**（Node 内置 undici），插件内**没有任何代理入口**：
 *
 * - undici **不读** Windows WinINET 系统代理（浏览器读，所以浏览器能打开授权页）；
 * - undici **不读** `HTTP(S)_PROXY`，除非额外开启 `NODE_USE_ENV_PROXY`（Node 22.21+/24+）。
 *
 * ⇒ 症状与 `gemini-oauth.ts` 文件头第 1 条注释（「浏览器显示授权成功，但面板里账号
 * 一直不出现」）**逐字同形**，极易被误判成 `client_secret` / `redirect_uri` 问题。
 *
 * ## 为什么复用 `opencode-proxy.ts` 的 `proxyFetch` 而不是自己写
 *
 * 缺陷 IKK4BY 已实测：外部 undici 的 Dispatcher 塞进**内置** fetch 的
 * `RequestInit.dispatcher` 会在 Node 22/24 上**恒抛** `UND_ERR_INVALID_ARG`
 * （两个 undici 版本的 handler 契约不同源）。故凡要传 dispatcher 的请求
 * **必须**走 `proxyFetch`（它内部用**同源**的 undici fetch）。这与 opencode
 * 是同一份实现，故直接复用，**不**写第二份。
 *
 * ## 作用域：**仅 Gemini**，不动全局 dispatcher
 *
 * opencode2dsh 的 R1 教训：两个插件抢全局槽位会互相短路整个路由层。
 * 宿主 DSH 启动器（`@deepseek-ai/dsh-http-proxy`）已在第一个插件加载前装过全局
 * dispatcher，用户导出 `HTTPS_PROXY` 时**裸 fetch 本来就被代理覆盖** —— 本模块
 * 补的是**宿主管不到的那一格**：只有环境变量、没有插件内出口时的 per-账号配置。
 */
import { asProxyText } from './account-pool.js';
import { networkBlockedHint } from './network-hint.js';
import { normalizeProxy } from './opencode.js';
import { proxyFetch } from './opencode-proxy.js';
export { normalizeProxy };
/**
 * 造「按账号取 fetcher」的解析器。
 *
 * ⚠️ **空账号 id（`''`）= 直连**：适配器在拿不到账号 id 时（无池 / 凭据不匹配）
 * 会用空串，此时**刻意直连**而不是查一个空 id 的账号 —— 查不到就是没配代理。
 */
export function createGeminiFetcherResolver(lookup) {
    return (accountId) => {
        // ⚠️ 空账号 id ⇒ **根本不查池**：查了会把「不知道是谁」变成「用某人的出口」。
        const raw = accountId === '' ? '' : asProxyText(lookup(accountId));
        if (raw.trim().length === 0) {
            // ⚠️ **退回全局 `fetch`**（而不是无脑用 undici fetch）：Node 24+ 的
            // `NODE_USE_ENV_PROXY` 等**宿主能力由内置 fetch 提供**，换成外部 undici
            // 会**静默丢掉**它们（`opencode-proxy.ts` 的 `proxyFetch` 内部也处理了这一格）。
            return fetch;
        }
        const normalized = normalizeProxy(raw);
        if (!normalized.ok) {
            throw new Error(`gemini: 账号 ${accountId} 的代理地址无效 — ${normalized.reason}`);
        }
        const proxy = normalized.proxy;
        // ⚠️ 不直接返回 `proxyFetch` 本身：它的第三参是必填的 `proxy`，
        // 而调用方按 `typeof fetch` 的两参签名调用。
        const send = (input, init) => proxyFetch(input, init ?? {}, proxy);
        return send;
    };
}
/**
 * 全仓**唯一**的 Gemini 账号代理解析器（Gitee issue IKLTZ2）。
 *
 * ## ⚠️ 为什么放这里而不是 `src/index.ts`
 *
 * 消费点有**三个**，其中两个在 `index.ts` 之前就能拿到引用：
 *
 * 1. `probeById.gemini`（`src/index.ts`，**模块级常量**，在 `apply()` 之前求值）；
 * 2. `GeminiAuth` / `GeminiAdapter` 的主接线（`src/index.ts` 的 `apply()`）；
 * 3. `credits.balances` 端点（`src/jet-hub-rpc.ts`）。
 *
 * 若把实例放在 `index.ts` 并从 `jet-hub-rpc.ts` 导入，就形成
 * `index → jet-hub-rpc → index` 的**环**（`index.ts` 本来就 import 它），
 * 在 ESM 下会把 `geminiFetchForAccount` 变成 TDZ 引用 ⇒
 * `credits.balances` 拿到 `undefined` 并**静默恒直连**（最难查的一类失效）。
 * ⇒ 单一实例住在**被依赖方向的下游**（本文件），两侧都只 import 它。
 *
 * ## 为什么池子要「可后填」
 *
 * `apply()` 里才有真正的 `AccountPool`，而上面第 1 个消费点在 `apply()` 之前
 * 就可能跑（账号卡片「测试」）。故用**可变引用** + 兜底直连，形状与 `index.ts`
 * 既有的 `sharedExpiryProbeRef` / `sharedChoiceCacheRef` 同款。
 */
let geminiPoolRef;
/** 由 `apply()` 在池子就绪后注入（未注入 / 传 `undefined` 时恒直连）。 */
export function setGeminiProxyPool(pool) {
    geminiPoolRef = pool;
}
/**
 * 进程内共用的 fetcher 解析器（三个消费点共用同一份，见上方「为什么放这里」）。
 *
 * ⚠️ 空账号 id / 池未就绪 ⇒ **直连**（不是抛错）：调用方（探测、换号后的重试）
 * 可能合法地拿不到账号 id，抛错会让「测试」按钮直接崩。
 */
export const geminiFetchForAccount = createGeminiFetcherResolver((accountId) => (geminiPoolRef === undefined ? '' : geminiPoolRef.geminiProxyFor(accountId)));
/**
 * 连到 Google 超时/连不上时的**用户可读**提示（修法 3）。
 *
 * ## ⚠️ 为什么「文案本身就是出路」
 *
 * 缺陷的报障形态是「浏览器授权成功、面板里账号一直不出现」，而
 * `refresh.ts` 把 `fetch failed` 归入**可重试的瞬时网络错误**（60s 重试一次、
 * 面板零提示）—— 用户与排障者都看不到任何指向「代理」的线索。
 *
 * ⚠️ **不要把这类错误归 `AUTH` / `QUOTA`**：那两类码会连 message 一起吞掉
 * （Issue IKLBSH 的复发形态），恰好把唯一指路文案吃掉。
 *
 * @param error 原始异常。
 * @param aborted 是否是**自己 arm 的超时**触发（与真正的连接失败区分）。
 *   ⚠️ **调用方必须真的读 signal.aborted**，不能恒传 `false`
 *   （IKLTZ2 审计 P2-2：原三处调用点全是字面量 `false`，于是
 *   `AbortSignal.timeout()` 触发的墙外连接超时 —— 恰恰是 IKLTZ2 的主症状 ——
 *   因为没有 `UND_ERR_*` 错误码而拿不到任何提示；这形同「写进去却没人读」）。
 * @returns 有代理嫌疑时返回提示语，否则返回 `undefined`（调用方用原措辞）。
 */
export function geminiNetworkHint(error, aborted) {
    // 判据与码表在 `network-hint.ts`（全仓唯一一份）—— 这里只负责 Gemini 专属的出路文案。
    // 曾经的重复实现见 git 历史：同一码表在 `refresh.ts` / 此处各有一份，改一处漏一处。
    return networkBlockedHint({
        error,
        aborted,
        subject: 'Google',
        remedy: 'Gemini 全部端点都在墙外，插件进程不走系统代理。'
            + '请为该账号设置出口代理（账号卡片上的「代理」按钮），或在启动 DSH 前导出 HTTPS_PROXY；'
            + '浏览器能授权是因为浏览器读系统代理，插件进程不读。',
    });
}
//# sourceMappingURL=gemini-proxy.js.map