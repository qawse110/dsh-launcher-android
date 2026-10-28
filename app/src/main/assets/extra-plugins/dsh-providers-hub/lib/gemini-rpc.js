/**
 * Gemini 的**账号出口代理**端点（Gitee issue IKLTZ2）。
 *
 * ## 缺陷背景
 *
 * Gemini 全部端点都在墙外，而 undici（Node 内置 fetch）**既不读** Windows WinINET
 * 系统代理、**也不读** `HTTP(S)_PROXY`（除非额外开 `NODE_USE_ENV_PROXY`）⇒
 * 「浏览器能打开授权页并点同意、面板里账号却一直不出现」。
 *
 * ## 为什么单独成文件（而不是塞进 `jet-hub-rpc.ts` 的 `switch`）
 *
 * ① **前缀分流**：`gemini.*` 需要与 `opencode.*` 一样在主 switch **之前**被试一次
 *    （理由见 `opencode-rpc.ts` 模块头：Jet Hub 只有一条 RPC 通道，主 switch 的
 *    `default` 会把不认识的方法报成 `unknown method`，**不让路**）；
 * ② **形状同构**：setProxy / testProxy 与 opencode 的同名端点**逐字段同构**，
 *    抄两份会漂移（这正是 AGENTS.md 的第一条红线）。
 *
 * ⚠️ 但**实现不复用 opencode 的 `handleOpencodeRpc`**：它绑的是
 * `setOpencodeProxy` / `OPENCODE.id`，而 Gemini 要写 `setGeminiProxy` /
 * `GEMINI.id`（见 `AccountPool` 里两套方法的注释：语义不同，不可合并）。
 * ⇒ 复用的是**判据与措辞**（`normalizeProxy` / `describeFetchError`），
 * 不是那份分派表。
 *
 * ## ⚠️ 为什么「测试代理」打的是 Google 而不是出口 IP 服务
 *
 * opencode 的测试打 `ip-api.com`（能显示出口 IP 与地区，信息量对用户有用）。
 * Gemini 这里的**唯一目的是「能不能连上 Google」** ⇒ 探测目标必须是
 * **Google 自己的端点**。用出口 IP 服务会产生一个**假阳性**：代理能通 ip-api
 * 却仍被 Google 拒（DNS 污染 / 分流规则 / Google 侧封禁），用户点「测试连接」
 * 看到绿色以为配好了，面板依然失败。
 *
 * ⚠️ 选 `oauth2.googleapis.com/token`：它对**任何**请求都会回一个 HTTP 响应
 * （无 body 也有 `invalid_request` 400），所以「拿到 HTTP 状态码」即证明
 * TCP + TLS + 代理握手全通 —— 不需要真凭据。
 */
import { normalizeProxy } from './gemini-proxy.js';
import { proxyFetch } from './opencode-proxy.js';
import { describeFetchError } from './opencode-rpc.js';
/** 探测连接用的超时（测试按钮不能无限等）。 */
const TEST_TIMEOUT_MS = 15_000;
/**
 * 探测目标（见模块头「为什么打 Google 而不是出口 IP 服务」）。
 *
 * ⚠️ 用 **token 端点**而不是 `https://www.google.com/`：后者会返回一整页 HTML
 * 并跟着 302 跳到地区域名，undici 会**自动跟随**重定向 ⇒ 「通」与「被墙」两种
 * 情况的响应差异不够干净。token 端点是纯 API，`POST` 无参数回 400，判定最稳。
 */
const PROBE_URL = 'https://oauth2.googleapis.com/token';
/**
 * 处理一个 `gemini.*` RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（同 `opencode-rpc.ts` 的契约：
 *          对未知方法回信封会把别的 provider 的方法名误判成「格式错误」）。
 */
export async function handleGeminiRpc(_ctx, pool, method, payload) {
    const fail = (message) => ({ ok: false, error: { code: 'bad-request', message } });
    const done = (value) => ({ ok: true, value });
    try {
        switch (method) {
            case 'gemini.setProxy': {
                const req = payload;
                if (typeof req?.accountId !== 'string' || req.accountId.length === 0) {
                    return fail('缺少 accountId');
                }
                const raw = typeof req.proxy === 'string' ? req.proxy : '';
                if (raw.trim().length === 0) {
                    // 空串 = 清除：账号回到直连。
                    await pool.setGeminiProxy(req.accountId, '');
                    return done({ proxy: '', label: '直连（本机出口）' });
                }
                const normalized = normalizeProxy(raw);
                if (!normalized.ok)
                    return fail(normalized.reason);
                await pool.setGeminiProxy(req.accountId, normalized.proxy.url);
                return done({ proxy: normalized.proxy.url, label: normalized.proxy.label });
            }
            case 'gemini.testProxy': {
                const req = payload;
                const normalized = normalizeProxy(typeof req?.proxy === 'string' ? req.proxy : '');
                if (!normalized.ok)
                    return fail(normalized.reason);
                const startedAt = Date.now();
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
                try {
                    // ⚠️ 必须走 `proxyFetch`（与 dispatcher 同源的 fetch）：用全局 fetch
                    // 会在 Node 22/24 上恒抛 `UND_ERR_INVALID_ARG`（缺陷 IKK4BY）。
                    const response = await proxyFetch(PROBE_URL, {
                        method: 'POST',
                        signal: controller.signal,
                    }, normalized.proxy);
                    // ⚠️ **不判 `response.ok`**：`400 invalid_request` 同样证明链路通，
                    // 把它当失败会让「测试连接」在正确配置下报红。
                    return done({
                        status: response.status,
                        latencyMs: Date.now() - startedAt,
                    });
                }
                catch (error) {
                    // ⚠️ **必须把 `cause` 带出来**（同 IKK4BY 第 2 点）：`error.message`
                    // 恒为 `fetch failed`，真因只在 `cause` 上。
                    return fail(`测试失败：${controller.signal.aborted ? '连接超时' : describeFetchError(error)}`
                        + '。Gemini 全部端点都在墙外，插件进程不走系统代理。');
                }
                finally {
                    clearTimeout(timer);
                }
            }
            default:
                // ⚠️ **必须返回 undefined**（见函数注释）。
                return undefined;
        }
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}
//# sourceMappingURL=gemini-rpc.js.map