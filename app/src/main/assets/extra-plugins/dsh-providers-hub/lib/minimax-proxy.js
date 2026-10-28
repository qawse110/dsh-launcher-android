/**
 * MiniMax 链路的**代理感知 fetcher**。
 *
 * ## 缺陷背景
 *
 * `agent.minimax.io`（国际站）按**出口 IP 所在国家**分流：中国大陆来源会被
 * 307 到中国站 `agent.minimaxi.com`，而中国站不认国际站 token ⇒
 * 「余额查询失败 / 模型不可用 / 401」，与凭据失效**逐字同形**（issue IKMEVG）。
 *
 * 插件既有的绕法是 `X-Forwarded-For`（`pool.minimaxXff()`）：**声明**一个海外 IP。
 * 但它有两个硬限制：
 *
 * - 上游若改为不信任该头，整条链路失效（届时只能如实报错）；
 * - 它只改**请求头**，不改真实出处 —— 上游按 TLS 指纹 / 其它信号分流时同样无效。
 *
 * 本模块补的是**真正换出口**那一格：给账号配 HTTP(S)/SOCKS5 代理，让请求
 * 从海外出去。两者**可叠加**：代理改真实出口，XFF 是应急兜底。
 *
 * ## 为什么复用 `opencode-proxy.ts` 的 `proxyFetch` 而不是自己写
 *
 * 缺陷 IKK4BY 已实测：外部 undici 的 Dispatcher 塞进**内置** fetch 的
 * `RequestInit.dispatcher` 会在 Node 22/24 上**恒抛** `UND_ERR_INVALID_ARG`
 * （两个 undici 版本的 handler 契约不同源）。故凡要传 dispatcher 的请求
 * **必须**走 `proxyFetch`（它内部用**同源**的 undici fetch）。这与 opencode /
 * gemini 是同一份实现，故直接复用，**不**写第三份。
 *
 * ## ⚠️⚠️ 为什么**只服务 `minimaxintl`**，不覆盖 `minimax`（中国版）
 *
 * 中国版的主机 `agent.minimax.cn` 在境内**直连才是最优**：给它挂代理反而让
 * 流量绕境外一圈（更慢、且可能被引到国际站）。两站的**存在理由相反** ——
 * 国际站是「不出海就连不上」，中国站是「出海了反而更差」。
 *
 * ⇒ 与 `opencodeProxy` / `geminiProxy` 同款取舍：**另开一个字段**
 * `minimaxIntlProxy`，不与别家共用（共用会让「清掉 Gemini 的代理」连带
 * 清掉国际站的出口配置，那两家的语义本来也不同）。
 *
 * ## 作用域：**仅 MiniMax 国际站**，不动全局 dispatcher
 *
 * opencode2dsh 的 R1 教训：两个插件抢全局槽位会互相短路整个路由层。
 * 宿主 DSH 启动器（`@deepseek-ai/dsh-http-proxy`）已在第一个插件加载前装过
 * 全局 dispatcher，用户导出 `HTTPS_PROXY` 时**裸 fetch 本来就被代理覆盖** ——
 * 本模块补的是**宿主管不到的那一格**：只有环境变量、没有插件内出口时的
 * per-账号配置。
 */
import { asProxyText } from './account-pool.js';
import { normalizeProxy } from './opencode.js';
import { proxyFetch } from './opencode-proxy.js';
export { normalizeProxy };
/**
 * 造「按账号取 fetcher」的解析器。
 *
 * ⚠️ **空账号 id（`''`）= 直连**：适配器在拿不到账号 id 时（无池 / 凭据不匹配）
 * 会用空串，此时**刻意直连**而不是查一个空 id 的账号 —— 查不到就是没配代理。
 *
 * ⚠️ 与 `createGeminiFetcherResolver` **形状逐字同构**（同一份判据的第三份拷贝，
 * 只换错误消息前缀）。刻意**不**抽成共享工厂：三家的错误消息、类型名与
 * 将来的专属逻辑都不同，合成一个会让「改 Gemini 的措辞」动到 MiniMax。
 */
export function createMinimaxFetcherResolver(lookup) {
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
            throw new Error(`minimaxintl: 账号 ${accountId} 的代理地址无效 — ${normalized.reason}`);
        }
        const proxy = normalized.proxy;
        // ⚠️ 不直接返回 `proxyFetch` 本身：它的第三参是必填的 `proxy`，
        // 而调用方按 `typeof fetch` 的两参签名调用。
        //
        // ⚠️ 与 `createGeminiFetcherResolver` 逐字同构（含 `as typeof fetch` 的
        // 收窄）：本家所有调用点传的都是 URL 字符串（`minimaxFetch` 的第一参就是
        // `string`），不存在 `Request` / `URL` 形态 ⇒ 收窄安全。
        const send = (input, init) => proxyFetch(input, init ?? {}, proxy);
        return send;
    };
}
/**
 * 全仓**唯一**的 MiniMax 国际站账号代理解析器。
 *
 * ## ⚠️ 为什么放这里而不是 `src/index.ts`
 *
 * 消费点分布在 `index.ts`（适配器接线 / 探测槽 / 余额选号）与
 * `minimax-rpc.ts`（testProxy），而 `jet-hub-rpc.ts` 那条链路**已经** import
 * `index.ts` ⇒ 把实例放在 `index.ts` 会形成环，在 ESM 下把引用变成 TDZ
 * ⇒ 拿到 `undefined` 并**静默恒直连**（gemini-proxy.ts 踩过的同型坑）。
 * ⇒ 单一实例住在**被依赖方向的下游**（本文件），两侧都只 import 它。
 *
 * ## 为什么池子要「可后填」
 *
 * `apply()` 里才有真正的 `AccountPool`，而探测槽（`probeById`）是**模块级常量**、
 * 在 `apply()` 之前就可能被求值。故用**可变引用** + 兜底直连，形状与
 * `index.ts` 既有的 `sharedExpiryProbeRef` / gemini 的 `geminiPoolRef` 同款。
 */
let minimaxPoolRef;
/** 由 `apply()` 在池子就绪后注入（未注入 / 传 `undefined` 时恒直连）。 */
export function setMinimaxProxyPool(pool) {
    minimaxPoolRef = pool;
}
/**
 * 进程内共用的 fetcher 解析器。
 *
 * ⚠️ 空账号 id / 池未就绪 ⇒ **直连**（不是抛错）：调用方（探测、换号后的重试）
 * 可能合法地拿不到账号 id，抛错会让「测试」按钮直接崩。
 */
export const minimaxIntlFetchForAccount = createMinimaxFetcherResolver((accountId) => (minimaxPoolRef === undefined ? '' : asProxyText(minimaxPoolRef.minimaxIntlProxyFor(accountId))));
/**
 * 探测槽用的 XFF 取值（**每次调用现读**，池未就绪 ⇒ `undefined` = 不附头）。
 *
 * ## ⚠️ 为什么探测需要它
 *
 * 探测适配器**刻意不传 `accountPool`**（`account-probe.ts` 的既定语义：只测
 * 这一个账号、不写任何标记）⇒ 适配器里「从池读 `minimaxXff()`」那条腿在探测
 * 路径上**恒空** ⇒ 用户设好的 XFF 在「测试 / 重测」上不生效 ⇒ 大陆出口的探测
 * 恒 307 → 401，报错文案与「凭据失效」同形（2026-10-24 活体实测：真机报文
 * `{"error":"invalid access token"}`），用户会去误删好号。
 *
 * XFF 是**只读**的展示性设置，探测带它不违反「探测不写任何状态」的语义
 * （与 `accountIdOverride` 同一条界线：显式传值，不挂编排）。
 *
 * ## ⚠️ 为什么是函数而不是常量（初版踩过）
 *
 * `probeById` 是**模块级常量**，`createProbeAdapter` 在每次探测时才调用 ⇒
 * 本函数在**那一次调用时**才求值，池那时已由 `apply()` 注入。
 * 若写成 `const xff = pool.minimaxXff()`（模块求值时算一次），池还没就绪
 * ⇒ 恒 `undefined` 且**永不更新**。
 *
 * ## ⚠️ 为什么放在本文件（而不是 `index.ts` 里的 globalThis 槽）
 *
 * 初版是 `globalThis.__jetHubMinimaxXffPool`（全仓唯一的 globalThis 注入槽）。
 * 代价见 {@link MinimaxProxyPoolLike.minimaxXff} 的注释：跨包副本串号、
 * dispose 后不清理、与代理侧两套机制。⇒ 收敛到同一个 `minimaxPoolRef`。
 */
export function minimaxIntlXffForProbe() {
    if (minimaxPoolRef === undefined)
        return undefined;
    return typeof minimaxPoolRef.minimaxXff === 'function'
        ? minimaxPoolRef.minimaxXff()
        : undefined;
}
//# sourceMappingURL=minimax-proxy.js.map