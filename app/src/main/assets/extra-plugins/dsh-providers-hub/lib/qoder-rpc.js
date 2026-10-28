/**
 * Qoder 的**账号出口代理**端点（真实报障 2026-10-21）。
 *
 * ## 缺陷背景
 *
 * Qoder 国际版全部端点（`openapi.qoder.sh`）在本机被 **SNI 阻断** ——
 * TCP 443 能握手（93ms），但 TLS ClientHello 被丢弃，`fetch` 恒 10.7s
 * `UND_ERR_CONNECT_TIMEOUT`。而**中国版**（`openapi.qoder.com.cn`）直连
 * 只要 160ms 就通。
 *
 * ⇒ 出口只能**按账号**配。配不了代理的症状是三层叠在一起：
 * ① 推理 `TRANSPORT: fetch failed`；② 余额恒 `null`（面板「一直读取中」二十秒
 * 后报「积分查询失败」）；③ 锁定状态下永远报「无法确认是否有可用账号」。
 * 三层里没有一层能让用户猜到「这个渠道在墙外」。
 *
 * ## 为什么单独成文件（而不是塞进 `jet-hub-rpc.ts` 的 `switch`）
 *
 * 与 `gemini-rpc.ts` 逐字同因：
 * ① **前缀分流**：`qoder.*` 需要与 `opencode.*` / `gemini.*` 一样在主 switch
 *    **之前**被试一次（Jet Hub 只有一条 RPC 通道，主 switch 的 `default`
 *    会把不认识的方法报成 `unknown method`，**不让路**）；
 * ② **形状同构**：setProxy / testProxy 与 opencode / Gemini 的同名端点
 *    **逐字段同构**，抄三份必漂移（AGENTS.md 第一条红线）。
 *
 * ⚠️ 但**实现不复用 `handleGeminiRpc`**：它绑的是 `setGeminiProxy` /
 * `GEMINI.id`，而 Qoder 要写 `setQoderProxy` / `product.id`（见 `AccountPool`
 * 里两套方法的注释：语义不同，不可合并）。复用的是**判据与措辞**
 * （`normalizeProxy` / `describeFetchError`），不是那份分派表。
 *
 * ## ⚠️ 为什么「测试代理」打的是 Qoder 自己的余额端点
 *
 * Gemini 那份打 `oauth2.googleapis.com/token`（任何请求都回 HTTP，拿到状态码
 * 即证明链路通）。这里**更进一步**打 `QODER_USAGE_PATH`：它需要真 Bearer
 * 才回 200，但不带 Token 也会回 **401** —— 同样证明「TCP + TLS + 代理握手
 * 全通」，且**目标一定是用户真正要访问的那台主机**。
 *
 * ⚠️ 用出口 IP 服务（`ip-api.com`）会产生假阳性：代理能通 ip-api 却仍被
 * 上游拒（DNS 污染 / 分流规则）⇒ 用户点「测试连接」看到绿色以为配好了，
 * 面板依然失败。opencode 打 ip-api 是因为它要展示出口地区，目的不同。
 */
import { normalizeProxy } from './gemini-proxy.js';
import { proxyFetch } from './opencode-proxy.js';
import { describeFetchError } from './opencode-rpc.js';
import { targetsProxyEntry } from './network-hint.js';
import { QODER_USAGE_PATH } from './qoder-credits.js';
import { QODER, QODER_CN } from './qoder-product.js';
/** 探测连接用的超时（测试按钮不能无限等）。 */
const TEST_TIMEOUT_MS = 15_000;
/**
 * 由 `provider` 形参取产品配置。
 *
 * ⚠️ **不抛错**：这是「测试连接」按钮，用户可能传了旧值 / 拼错的名字。
 * 抛错会让按钮报「bad request」，而它真正想问的是「这条代理通不通」。
 * 未知值退国际版（`QODER`），因为它是默认站。
 */
function productOf(provider) {
    if (provider !== undefined && provider.length > 0) {
        if (provider === QODER_CN.id)
            return QODER_CN;
        if (provider !== QODER.id) {
            // 未知名字：按「不是中国版就是国际版」的兜底处理，不抛错。
            return QODER;
        }
    }
    return QODER;
}
/**
 * 处理一个 `qoder.*` RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（同 `opencode-rpc.ts` /
 *          `gemini-rpc.ts` 的契约：对未知方法回信封会把别的 provider 的
 *          方法名误判成「格式错误」）。
 */
export async function handleQoderRpc(_ctx, pool, method, payload) {
    const fail = (message) => ({ ok: false, error: { code: 'bad-request', message } });
    const done = (value) => ({ ok: true, value });
    try {
        switch (method) {
            case 'qoder.setProxy': {
                const req = payload;
                if (typeof req?.accountId !== 'string' || req.accountId.length === 0) {
                    return fail('缺少 accountId');
                }
                const raw = typeof req.proxy === 'string' ? req.proxy : '';
                if (raw.trim().length === 0) {
                    // 空串 = 清除：账号回到直连。
                    await pool.setQoderProxy(req.accountId, '');
                    return done({ proxy: '', label: '直连（本机出口）' });
                }
                const normalized = normalizeProxy(raw);
                if (!normalized.ok)
                    return fail(normalized.reason);
                await pool.setQoderProxy(req.accountId, normalized.proxy.url);
                return done({ proxy: normalized.proxy.url, label: normalized.proxy.label });
            }
            case 'qoder.testProxy': {
                const req = payload;
                const normalized = normalizeProxy(typeof req?.proxy === 'string' ? req.proxy : '');
                if (!normalized.ok)
                    return fail(normalized.reason);
                const product = productOf(typeof req?.provider === 'string' ? req.provider : undefined);
                const startedAt = Date.now();
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
                try {
                    // ⚠️ 必须走 `proxyFetch`（与 dispatcher 同源的 fetch）：用全局 fetch
                    // 会在 Node 22/24 上恒抛 `UND_ERR_INVALID_ARG`（缺陷 IKK4BY）。
                    const response = await proxyFetch(`${product.openApiBase}${QODER_USAGE_PATH}`, { method: 'GET', signal: controller.signal }, normalized.proxy);
                    // ⚠️ **不判 `response.ok`**：401（没带 Token）/ 403 同样证明链路通
                    // —— 它们都是上游回的 HTTP 响应。把它当失败会让「测试连接」在
                    // 正确配置下报红（与 gemini-rpc 的 `400 invalid_request` 同因）。
                    return done({
                        status: response.status,
                        latencyMs: Date.now() - startedAt,
                        host: product.openApiBase,
                    });
                }
                catch (error) {
                    // ⚠️ **必须把 `cause` 带出来**（同 IKK4BY 第 2 点）：`error.message`
                    // 恒为 `fetch failed`，真因只在 `cause` 上。
                    const detail = controller.signal.aborted ? '连接超时' : describeFetchError(error);
                    /**
                     * ⚠️⚠️ **归因必须分道：不得把「代理软件没启动」说成目标站点的事**
                     * （2026-10-22 真实报障）。`ECONNREFUSED 127.0.0.1:7897` 与「站点
                     * 连不上」在 `NETWORK_BLOCKED_CODE_RE` 里是**同一类**，但处置相反：
                     *
                     * - 被拒的是**用户填的代理入口** ⇒ 那个端口上没有程序在监听 ⇒
                     *   该做的是「启动代理软件 / 核对地址端口」；
                     * - 被拒的才是**目标站点** ⇒ 才该换出口、换线路或换站点。
                     *
                     * 旧文案对前者也照抄「国际版被 SNI 阻断」，用户于是去查网络、
                     * 换账号，而正确动作只是**把代理软件打开**。判据只有一份实现
                     * （`network-hint.ts` 的 `targetsProxyEntry`），这里只做分道。
                     */
                    if (targetsProxyEntry(error, normalized.proxy.url)) {
                        return fail(
                        // ⚠️⚠️ **只回显 `label`（已脱敏），绝不回显 `url`**（2026-10-25 审计 A2-01）。
                        //    旧写法是 `代理 ${label}（${url}）没有在监听` —— 同一句里先脱敏、
                        //    紧接着又把带明文口令的 `url` 贴回来，**自己拆自己的台**。
                        //    该文案是用户在弹窗里最容易**整段复制粘贴**的东西（贴进 issue / 截图），
                        //    而 label 已经够用：它保留了 host:port 与用户名、只把口令打成 `***`。
                        `测试失败：${detail}。代理 ${normalized.proxy.label}`
                            + '没有在监听（连接被拒绝）—— 先启动代理软件、核对地址与端口，'
                            + '或清空代理回到直连（两个站点直连都能通）。');
                    }
                    return fail(`测试失败：${detail}`
                        + `。探测目标是 ${product.openApiBase}；`
                        + (product.id === QODER.id
                            // ⚠️ 不得断言机制：SNI 阻断只是**可能**之一，本地代理/分流规则
                            // 把该域名转给不通的节点同样会长成这样（2026-10-23 实测的真凶）。
                            ? '国际版可能在本机被 SNI 阻断（TCP 能连、TLS 握手被丢），也可能是本地代理/分流规则把它转给了不通的节点 —— 换条线路、清空代理重试，或改用中国版。'
                            : '中国版通常直连就通；若这条代理不通，清空代理回到直连即可。'));
                }
                finally {
                    clearTimeout(timer);
                }
            }
            default:
                return undefined;
        }
    }
    catch (error) {
        return { ok: false, error: { code: 'internal', message: describeFetchError(error) } };
    }
}
//# sourceMappingURL=qoder-rpc.js.map