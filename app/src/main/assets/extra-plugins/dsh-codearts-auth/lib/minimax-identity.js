/**
 * MiniMax 账号身份读取（Gitee issue IKP8UA）。
 *
 * ## 为什么不从 token 里解
 *
 * MiniMax 的 `access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、**0 个点**），
 * 而原昵称判据走的是 `decodeJwtSub(accessToken)` ⇒ **恒 undefined** ⇒
 * 账号卡片恒退化为插件内部 id（`minimax-6395cf64`），多账号时无法分辨。
 *
 * 登录响应体本身也**不含身份**（实测字段全集：`access_token` / `expires_in` /
 * `refresh_token` / `scope` / `token_type`）⇒ 必须**另查一个端点**。
 *
 * ## 端点（真机实测定位，2026-10-23）
 *
 * ```
 * GET {apiHost}/v1/api/user/info?device_platform=web&biz_id=3
 * Authorization: Bearer <access_token>
 * ```
 *
 * 只需 Bearer —— **不需要**官方客户端那套 `yy` / `x-timestamp` / `x-signature` 签名头。
 *
 * ## ⚠️⚠️ 判据为什么落在 `name` 非空，而不是 `statusInfo` 无错码
 *
 * 两站的**参数缺失失败形态完全不同**（实测矩阵）：
 *
 * | 情形 | 国内站 | 国际站 |
 * |---|---|---|
 * | 参数齐全 | 200、`code=0`、`name="MiniMax909127"` | 200、`code=0`、`name="8fsmz"` |
 * | **缺 `biz_id=3`** | 200、`code=1200019`、`userInfo` **整块缺失** | 200、**`code=0`**、但 `name=""`、`userID` 变成**另一个值**、`realUserID="0"` |
 * | 缺 `device_platform=web` | 400、`code=2` | 400、`code=2` |
 *
 * ⇒ 只看 `statusInfo.code === 0` 时，**国际站缺 `biz_id` 会被判成功**，
 *   而它给出的是空名字 —— 显示空白比显示内部 id 更糟。
 * ⇒ 故判据是 **`userInfo.name` 非空**（且 `statusInfo` 无错码，作为国内站那道）。
 *
 * ## ⚠️⚠️ 国际站必须带 `X-Forwarded-For`
 *
 * `agent.minimax.io` 对**所有**路径按请求来源 IP 的**国别**返 `307 → agent.minimaxi.com`
 * （Akamai 判定，见 `src/minimax.ts` 的 `withMinimaxXff`）。大陆出口**恒 307**，
 * 而 fetch 跨 origin 跟随会剥掉 `Authorization` ⇒ 第二跳无凭据 ⇒ **401**。
 *
 * 实测（2026-10-23，本机真实国际站凭据）：
 *
 * ```
 * 仅 Bearer            → 307 → agent.minimaxi.com → 401
 * XFF=114.114.114.114  → 307 → 同上 → 401        ← 中国 IP 照样被踢
 * XFF=8.8.8.8 / 1.1.1.1 → 200（不重定向）name="8fsmz"   ✅
 * ```
 *
 * ⇒ 传输必须走 `minimaxFetch`（它保凭据跟随重定向 + 传输级重试），
 *   头必须经 `minimaxHeadersFor`（**只对国际站**附 XFF）。
 *
 * ⚠️ **拿不到身份不是错误**：昵称是展示信息，失败一律返回 `undefined`，
 *    由调用方退回内部 id（与 qoder 的 `fetchQoderUserNickname` 同原则）。
 */
import { minimaxFetch } from './minimax.js';
import { minimaxHeadersFor } from './minimax.js';
/**
 * 身份端点的路径（**不带 query**）。
 *
 * ⚠️ 两个 query 参数是**必需**的，缺任一都会失败（真机逐项消融实测，12 组）：
 * - 缺 `device_platform=web` ⇒ **400 / `code=2`**（`userID参数错误`）；
 * - 缺 `biz_id=3` ⇒ 200 但**数据是错的**（见模块头的矩阵）。
 *
 * 而 `app_id` / `version_code` / `is_desktop` / `client` / `unix` 均可省。
 */
export const MINIMAX_USERINFO_PATH = '/v1/api/user/info';
/** 必需的两个 query 参数（顺序无关，但**一个都不能少**）。 */
const USERINFO_QUERY = '?device_platform=web&biz_id=3';
/** 身份读取的超时预算（毫秒）。 */
const MINIMAX_USERINFO_TIMEOUT_MS = 8_000;
/** 从任意形状的响应里安全取一个非空字符串。 */
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
/** 从任意形状里取一层对象。 */
function recordOf(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * 解析身份响应。
 *
 * ⚠️ 形状容忍（两站/两种信封都见过）：业务载荷在 `data.userInfo`，
 *    但**不排除**将来平铺到顶层 `userInfo` ⇒ 两处都看，**先 `data` 后顶层**
 *    （与 `minimax-credits.ts` 的 `unwrapEnvelopeData` 同取向）。
 *
 * ⚠️ **`statusInfo` 有非零 `code` ⇒ 直接判取不到**：国内站缺 `biz_id` 就是
 *    靠这一条拦住的（`code=1200019` 且 `userInfo` 整块缺失）。
 *    而国际站那条 `code=0` 的坏数据由下面的 **`name` 非空** 拦住 ——
 *    两道判据缺一不可（各挡一个站）。
 */
export function parseMinimaxUserIdentity(payload) {
    const root = recordOf(payload);
    if (root === undefined)
        return undefined;
    // ① 业务状态码：有非零 code 一律判失败（国内站的错误形态）。
    const status = recordOf(root.statusInfo) ?? recordOf(root.base_resp) ?? recordOf(root.baseResp);
    if (status !== undefined) {
        const code = status.code ?? status.status_code;
        if (typeof code === 'number' && code !== 0)
            return undefined;
        // ⚠️ 有的形态把 code 放成字符串（`"0"`）—— 同样按「非零即失败」判。
        if (typeof code === 'string' && code.trim() !== '' && code.trim() !== '0')
            return undefined;
    }
    // ② 身份块：先 `data.userInfo`，再顶层 `userInfo`。
    const data = recordOf(root.data);
    const userInfo = recordOf(data?.userInfo) ?? recordOf(root.userInfo);
    if (userInfo === undefined)
        return undefined;
    // ③ 判据核心：**name 非空**。国际站缺 `biz_id` 时 code 是 0 但 name 为空，
    //    这一条是唯一能拦住它的判据（见模块头矩阵）。
    const name = nonEmptyString(userInfo.name);
    if (name === undefined)
        return undefined;
    const userId = nonEmptyString(userInfo.userID);
    return userId === undefined ? { name } : { name, userId };
}
/**
 * 读一次账号身份。
 *
 * @param credential 凭据（只需 `access_token`）。
 * @param fetcher 注入的 fetch（单测用；缺省全局）。
 * @param product 产品（决定 `apiHost` 与**是否附 XFF**）。
 * @param xff 国际站绕地理分流用的来源 IP（用户设置值；国内站**忽略**）。
 * @returns 身份；**任何失败都返回 `undefined`**（不抛错）。
 */
export async function fetchMinimaxUserIdentity(credential, fetcher = fetch, product, xff) {
    const url = `${product.apiHost}${MINIMAX_USERINFO_PATH}${USERINFO_QUERY}`;
    try {
        // ⚠️⚠️ **必须走 `minimaxFetch`**（不是裸 fetch）：它同时给三样东西 ——
        //    ① 传输级重试（本机环境 HTTPS 检查代理约 50% 概率打断，裸 fetch 随机失败）；
        //    ② **保凭据跟随 3xx**（国际站 307 到 `agent.minimaxi.com` 时，fetch 会自动
        //       剥掉 `Authorization` ⇒ 第二跳无凭据 ⇒ 401，真机实测过）；
        //    ③ `onGeoRoute` 观测点（本函数用不到，但走同一份实现才有该能力）。
        // ⚠️ 头必须经 `minimaxHeadersFor`：**只对国际站**附 XFF。
        //    给国内站附 XFF 是伪造来源（且对国内站无用）。
        const response = await minimaxFetch(url, () => ({
            method: 'GET',
            headers: minimaxHeadersFor(credential, xff, product.id),
            signal: AbortSignal.timeout(MINIMAX_USERINFO_TIMEOUT_MS),
        }), { fetcher });
        if (!response.ok)
            return undefined;
        const text = await response.text();
        let payload;
        try {
            payload = JSON.parse(text);
        }
        catch {
            // 非 JSON（网关降级返回 HTML 等）⇒ 当作没读到。
            return undefined;
        }
        return parseMinimaxUserIdentity(payload);
    }
    catch {
        // 网络异常 / 超时 / 非传输错误：一律吞掉。
        // ⚠️ 昵称是**展示信息**，拿不到就退回内部 id —— 绝不能因此阻塞登录或启动
        //    （与 qoder 的 `fetchQoderUserNickname` 同原则）。
        return undefined;
    }
}
//# sourceMappingURL=minimax-identity.js.map