/**
 * Qoder 链路的**代理感知 fetcher**（真实报障 2026-10-21）。
 *
 * ## 缺陷背景
 *
 * Qoder **国际版**（`openapi.qoder.sh`）在本机被 SNI 阻断：DNS 正常、TCP 443
 * 握手正常，但 **TLS ClientHello 被丢**（典型 GFW 行为）。实测两个真实账号：
 *
 * - 余额端点 `GET /sash/api/v2/me/usage` ⇒ 10.7–11.3s 后 `UND_ERR_CONNECT_TIMEOUT`
 * - 推理通道 `/api/v1/agent_chat_generation` ⇒ 同样 10.7s `TRANSPORT: fetch failed`
 *
 * ⇒ 整个渠道**没有实际推理能力**。而**中国版**（`openapi.qoder.com.cn`）完全
 * 正常（余额 160ms、推理 434ms）。
 *
 * 在本模块之前，Qoder 是本插件里**唯一**有墙外端点却没有 per-账号代理入口的
 * 渠道（opencode 有 `opencodeProxy`、Gemini 有 `geminiProxy`）—— 用户唯一出路
 * 是在启动 DSH 前导出 `HTTPS_PROXY`，而那会**让所有渠道一起走代理**，
 * 包括本来直连只要 160ms 的中国版。
 *
 * ## 为什么复用 `opencode-proxy.ts` 的 `proxyFetch` 而不是自己写
 *
 * 与 Gemini 那份同因（缺陷 IKK4BY 实测）：外部 undici 的 Dispatcher 塞进
 * **内置** fetch 的 `RequestInit.dispatcher` 会在 Node 22/24 上**恒抛**
 * `UND_ERR_INVALID_ARG`（两个 undici 版本的 handler 契约不同源）。故凡要传
 * dispatcher 的请求**必须**走 `proxyFetch`（它内部用**同源**的 undici fetch）。
 * 同一份实现已在 opencode / Gemini 用着，**不**写第三份。
 *
 * ## 与 Gemini 那份的三点差异（不要照抄）
 *
 * ① **不导出 `normalizeProxy`**：Qoder 的调用点（`qoder-rpc.ts`）直接从
 *   `opencode.js` 取 —— Gemini 那份转导出是为了让 `gemini-rpc.ts` 少一个 import，
 *   照抄只会多一条无意义的转发。
 * ② **空账号 id 的语义**：Gemini 传空 id 时**刻意直连**（探测路径拿不到 id）。
 *   Qoder 另有一条「**登录时还没有账号**」的路径（见 `types.ts` 的
 *   `geminiProxy` 注释所记的死锁），故本模块额外提供
 *   {@link QODER_PENDING_PROXY_KEY} 作为「占位账号」的键，让登录也能走代理。
 * ③ 本模块**不做** `networkBlockedHint` —— 那是 `qoder-credits.ts` 的
 *   `fetchQoderBalanceDetailed` 与 `qoder-adapter.ts` 的传输层各自的事，
 *   本文件只负责「按账号选出口」这一件事。
 */
import { asProxyText } from './account-pool.js';
import { normalizeProxy } from './opencode.js';
import { proxyFetch } from './opencode-proxy.js';
/**
 * 「还没有账号 id」时用的代理键（登录流程专用）。
 *
 * ## ⚠️ 为什么需要它（与 Gemini 同款死锁，但 Qoder 更严重）
 *
 * 登录流程的顺序是：**① 拿授权码 → ② 换 token（此刻才读代理）→ ③ 写入账号**。
 * 若第 ② 步只能读「已有账号的代理」，那么：
 *
 * - 墙外环境下（国际版默认如此）第 ② 步恒直连 ⇒ **登录恒失败**；
 * - 而用户**没法给一个还不存在的账号配代理**（面板的「代理」按钮按
 *   `accountId` 打开）⇒ **死锁**：唯一出路是导出环境变量。
 *
 * ⇒ 本键让「新建账号」表单能把代理**先存进池**，登录时按它取出口。
 *
 * ⚠️ 用**可读的字符串**而不是随机 id：它会被写进 `state.json`，
 *   排障时一眼能认出「这是登录预置的那条」。
 */
export const QODER_PENDING_PROXY_KEY = '__qoder_pending__';
/**
 * 造「按账号取 fetcher」的解析器。
 *
 * ⚠️ **空账号 id（`''`）= 直连**，但**会先试** {@link QODER_PENDING_PROXY_KEY}：
 * 登录流程拿不到账号 id 时，用户可能已经在新账号表单里预置了代理。
 * 这条兜底**只对空 id 生效** —— 有 id 时绝不回落到 pending（那会让某个真实
 * 账号莫名走另一份出口配置）。
 */
export function createQoderFetcherResolver(lookup) {
    return (accountId) => {
        // ⚠️ 空账号 id ⇒ 先试「登录预置」那条，再退直连。
        //    查一个空 id 的账号是无意义的（池里不存在这种键），但查 pending
        //    是登录流程唯一能拿到代理的途径。
        const key = accountId === '' ? QODER_PENDING_PROXY_KEY : accountId;
        const raw = asProxyText(lookup(key));
        if (raw.trim().length === 0) {
            // ⚠️ **退回全局 `fetch`**（而不是无脑用 undici fetch）：Node 24+ 的
            // `NODE_USE_ENV_PROXY` 等**宿主能力由内置 fetch 提供**，换成外部 undici
            // 会**静默丢掉**它们（`opencode-proxy.ts` 的 `proxyFetch` 内部也处理了这一格）。
            return fetch;
        }
        const normalized = normalizeProxy(raw);
        if (!normalized.ok) {
            throw new Error(`qoder: 账号 ${accountId === '' ? key : accountId} 的代理地址无效 — ${normalized.reason}`);
        }
        const proxy = normalized.proxy;
        // ⚠️ 不直接返回 `proxyFetch` 本身：它的第三参是必填的 `proxy`，
        // 而调用方按 `typeof fetch` 的两参签名调用。
        const send = (input, init) => proxyFetch(input, init ?? {}, proxy);
        return send;
    };
}
/**
 * 全仓**唯一**的 Qoder 账号代理解析器。
 *
 * ## ⚠️ 为什么放这里而不是 `src/index.ts`
 *
 * 消费点有**四处**，其中两处在 `index.ts` 之前就可能跑：
 *
 * 1. `probeById.qoder` / `probeById.qodercn`（`src/index.ts`，**模块级常量**，
 *    在 `apply()` 之前求值）；
 * 2. `QoderAuth` 的续期与登录（`src/qoder-auth.ts`）；
 * 3. `QoderAdapter` 的推理通道（`src/index.ts` 的 `apply()`）；
 * 4. `credits.balances` 端点（`src/jet-hub-rpc.ts`）与「刷新积分」按钮。
 *
 * 若把实例放在 `index.ts` 并从 `jet-hub-rpc.ts` 导入，就形成
 * `index → jet-hub-rpc → index` 的**环**（`index.ts` 本来就 import 它），
 * 在 ESM 下会把 `qoderFetchForAccount` 变成 TDZ 引用 ⇒ 拿 `undefined`
 * 并**静默恒直连**（最难查的一类失效，与 Gemini 那份的记录同款）。
 * ⇒ 单一实例住在**被依赖方向的下游**（本文件），两侧都只 import 它。
 *
 * ## 为什么池子要「可后填」
 *
 * `apply()` 里才有真正的 `AccountPool`，而上面第 1 个消费点在 `apply()` 之前
 * 就可能跑（账号卡片「重测」/「测试」）。故用**可变引用** + 兜底直连，
 * 形状与 `index.ts` 既有的 `sharedExpiryProbeRef` / `sharedChoiceCacheRef` 同款。
 */
let qoderPoolRef;
/** 由 `apply()` 在池子就绪后注入（未注入 / 传 `undefined` 时恒直连）。 */
export function setQoderProxyPool(pool) {
    qoderPoolRef = pool;
}
/**
 * 进程内共用的 fetcher 解析器（四个消费点共用同一份，见上方「为什么放这里」）。
 *
 * ⚠️ 空账号 id / 池未就绪 ⇒ **直连**（不是抛错）：调用方（探测、换号后的重试、
 * 登录）可能合法地拿不到账号 id，抛错会让「测试」按钮直接崩。
 */
export const qoderFetchForAccount = createQoderFetcherResolver((accountId) => (qoderPoolRef === undefined ? '' : qoderPoolRef.qoderProxyFor(accountId)));
//# sourceMappingURL=qoder-proxy.js.map