/**
 * MiniMax Code（**中国版 + 国际版**）产品配置。
 *
 * ## 为什么新建 `MinimaxProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` / `LoomyProduct` /
 * `RaccoonProduct` 的字段全部围绕各自协议设计（归属头、WASM 签名参数、
 * 手机号加密密钥、倍率…），对 MiniMax 无一有意义。
 * MiniMax 需要的是：**一组 OAuth 端点 + 目录 region/buildEnv + 兜底模型表**。
 * 故定义**平行**接口 —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## ⚠️ 双站点（两个 provider id）—— 2026-10-15 新增国际版
 *
 * 两个站点**账号不互通**（国内平台与国际平台是两套账号），故它们是**两个
 * provider**（`minimax` / `minimaxintl`），与 `qoder`/`qodercn` 同型；
 * **不是**「一个 provider 加一个区域参数」——后者要把站点存进凭据并让每个
 * 请求点都按凭据解析主机，而模型目录是按 provider 缓存一份的（`loadModels`
 * 的 `this.remoteModels`）⇒ 两站目录会互相覆盖。
 *
 * ⚠️ **两站只差 6 个字段**，其余逐字段相同（OAuth 常量、全部端点路径、兜底表）：
 *
 * | 字段 | `minimax`（中国版） | `minimaxintl`（国际版） |
 * |---|---|---|
 * | `id` | `minimax` | `minimaxintl` |
 * | `displayName` | `MiniMax Code (中国版)` | `MiniMax Code (国际版)` |
 * | `accountHost` | `account.minimax.cn` | `account.minimax.io` |
 * | `apiHost` | `agent.minimax.cn` | `agent.minimax.io` |
 * | `region` | `cn` | `en` |
 * | `defaultCredentialRef` | `MINIMAX_ACCESS_TOKEN` | `MINIMAXINTL_ACCESS_TOKEN` |
 *
 * ⇒ 因此**不复制任何** `src/minimax*.ts` 实现文件：适配器 / 认证服务 / OAuth /
 * 积分 / 消息序列化全部共用，差异只在本文件的配置常量里。
 *
 * ## ✅ 国际站真机验证结论（2026-10-15，**两站同形、认证方式相同**）
 *
 * 用真实国际站账号（`MINIMAXINTL_ACCOUNT_*`，经本插件登录）逐端点实测，并与官方
 * 开源实现 `MiniMax-AI/minimax-code`（v0.6.11 打包产物 + 源码）逐字对拍：
 *
 * | 项 | 本文件取值 | 依据 |
 * |---|---|---|
 * | OAuth 主机 | `account.minimax.io` | 官方 `oauth-core/src/endpoint-config.ts` 的 `ACCOUNT_ORIGINS.en.prod`；且官方 `mcode login --region global` 打开的**就是**该主机 |
 * | 推理基址 | `agent.minimax.io/mavis/api/v1/llm/v1` | 官方 `config/src/config.ts` 的 `PRESET_BASE_URLS['en-prod']` |
 * | 推理路径 | `/mavis/api/v1/llm/v1/messages` | 同上（基址 + `/messages`） |
 * | 推理认证 | **`Authorization: Bearer <access_token>`** | 官方 `local-model-resolver.ts:789`；**探针实测官方请求头也只有它**（另有 `x-api-key: sk-xxx` 占位与 `x-mavis-*`，但缺之亦通） |
 * | OAuth 常量 | `mcode-public` / `agent.default` / `agent-backend` | 官方 `oauth-core/src/contracts.ts` 三个常量逐字一致 |
 * | 目录 / 签到 / 积分 | `GET /mavis/api/v1/models?region=en&buildEnv=prod`、`/minimax-cloud/api/v1/{signin,credit}/*` | **实测全部 200**（见下） |
 *
 * **实测结果**（本插件自己的代码路径，e2e 探针 4/4 通过）：
 *
 * ```
 * [minimaxintl] 模型目录 4 条：M3.1-Flash-Preview(1000K) / M3(1000K) / M2.7-highspeed(200K) / M2.7(200K)
 * [minimaxintl] 签到状态：今日已领=true 连续=1 今日额度=400
 * [minimaxintl] 积分余额：394.8
 * 推理：200 + 真实 SSE（Bearer 即可，与国内站一致）
 * ```
 *
 * ⇒ **国际站与国内站协议同形**，本文件的「两站只差 6 个字段」成立，共用实现正确。
 *
 * ## ⚠️⚠️ 一段**已被证伪**的中间结论（留作教训，勿再采信）
 *
 * 2026-10-15 中途我曾据一次**上游故障窗口**内的探测，写下「国际站要求阿里云 ALB
 * 网关签名、推理与签到/积分不可用」的结论，并据此在文档里断言
 * `400 invalid signature` / `401 token is required` 是国际站的设计而非故障。
 * **该结论是错的。** 故障恢复后同样的请求全部 200。当时的错因有三：
 *
 * 1. **把瞬时故障当成设计**：`invalid signature` / `token is required` 是上游网关在
 *    故障期返回的通用错误，恢复后即消失；
 * 2. **对照组选错**：我当时用「国内站通、国际站不通」推断「两站不同形」，但**没有
 *    先让官方客户端复现** —— 后来跑 `mcode` 才发现**官方自己也连不上**（截图
 *    `Code: 50112` = 官方枚举 `LLM_AUTH_ERROR`），那才是决定性证据；
 * 3. **烧掉了用户凭据**：为判断凭据归属，我对两个真实账号调了 `refresh_token`
 *    却**没有写回**，服务端轮换后旧 token 作废 —— **诊断脚本绝不该对真实凭据
 *    发起 refresh，无论是否写回**。
 *
 * 教训（可推广）：**区分「客户端 bug」与「服务端故障」时，先让官方/参考实现复现**，
 * 成本最低、结论最硬；不要拿一个失败面的组合去反推协议差异。
 *
 * ## 数据来源
 *
 * - 国际站主机 / OAuth 端点 / 推理基址 / OAuth 常量：**官方开源仓库**
 *   `MiniMax-AI/minimax-code`（2026-10-15 逐文件核对，见上表）；
 * - 国际站端点行为（上表的 ❌ 部分）：2026-10-15 **真实国际站账号**逐端点实测；
 * - 国内站主机与端点：asar `@mavis/config/dist/config.js` 的
 *   `PRESET_BASE_URLS['cn-prod']` + `@mavis/oauth-core/dist/endpoint-config.js`；
 * - 国内站 `clientId` / `scope` / `audience`：`~/.minimax/auth/prod/cn/mcode-public/auth.json`
 *   与 asar `contracts.js`；
 * - 兜底模型表：2026-09-28 实测 `GET /mavis/api/v1/models?region=cn&buildEnv=prod`。
 */
/**
 * 兜底模型目录（4 条，顺序**照抄远端 `model_order`**）。
 *
 * ⚠️ **必须含 `MiniMax-M3.1-Flash-Preview`** —— 它**不在**客户端内置静态表里
 * （asar `config.js` 的 `MINIMAX_MODELS` 只有 3 个：M3 / M2.7-highspeed / M2.7）。
 * 若兜底表也漏掉它，远端一失败用户就**看不到自己在用的模型**。
 *
 * ⚠️ **只有 M3.1-Flash-Preview 有 `effortOptions`** —— 其余三个远端
 * **没有 `effort_options` 字段**。给它们编档位就是凭空猜测
 * （与 Qoder「`qmodel` 没有档位就是没有，不要按截图猜」同型教训）。
 */
const MINIMAX_FALLBACK_MODELS = [
    {
        id: 'MiniMax-M3.1-Flash-Preview',
        name: 'M3.1-Flash-Preview',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        supportsImage: true,
        effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'default',
        // ⚠️ forced_on：传 disabled 会被服务端**硬拒**（400 `requires adaptive
        // thinking ... (2013)`，实测）。它与 M2.7 的 forced_on 不同形态：
        // M2.7 是**静默忽略**，M3.1 是**报错**。
        thinkingMode: 'forced_on',
    },
    {
        id: 'MiniMax-M3',
        name: 'M3',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        supportsImage: true,
        // ⚠️ 实测可开关思考（`switchable`）：不传/disabled → 0 思考块，
        // adaptive → 有思考块。官方形态见远端 `variants`。
        // ⚠️ 但它**没有 `effort_options`** ⇒ 没有「档位」可选，
        // 只有「开/关」两态 —— 与 Qoder `qmodel` 的「只有关闭思考」同型。
        thinkingMode: 'switchable',
    },
    {
        id: 'MiniMax-M2.7-highspeed',
        name: 'M2.7-highspeed',
        contextWindow: 200_000,
        maxTokens: 128_000,
        supportsImage: false,
        // ⚠️ forced_on：传 disabled 被**静默忽略**（实测仍产出思考块）
        thinkingMode: 'forced_on',
    },
    {
        id: 'MiniMax-M2.7',
        name: 'M2.7',
        contextWindow: 200_000,
        maxTokens: 128_000,
        supportsImage: false,
        thinkingMode: 'forced_on',
    },
];
/** MiniMax Code **中国版** provider 配置。 */
export const MINIMAX = {
    id: 'minimax',
    // ⚠️ 与国际版并列后必须带括注，否则用户分不清哪个是国内站
    //（与 `Qoder (中国版)` / `WorkBuddy (国际版)` 的既有命名风格一致）。
    displayName: 'MiniMax Code (中国版)',
    accountHost: 'https://account.minimax.cn',
    apiHost: 'https://agent.minimax.cn',
    region: 'cn',
    buildEnv: 'prod',
    clientId: 'mcode-public',
    audience: 'agent-backend',
    scope: 'agent.default',
    defaultCredentialRef: 'MINIMAX_ACCESS_TOKEN',
    fallbackModels: MINIMAX_FALLBACK_MODELS,
    maxImageBytesInline: 10 * 1024 * 1024,
    maxRequestBodyBytes: 64 * 1024 * 1024,
};
/**
 * MiniMax Code **国际版** provider 配置。
 *
 * ⚠️ 与 {@link MINIMAX} **只差 6 个字段**（见本文件头的对照表），其余逐字段
 * 相同 —— 这正是「不复制实现文件」的前提。
 *
 * ⚠️ 兜底表与国内站**共用同一份**：国际站远端目录未真机采集，而远端目录
 * 永远是首选（`MinimaxAuth.fetchRawModels`），兜底表只在远端失败时兜住
 * 「一个模型都看不到」这种最坏情况。
 */
export const MINIMAX_INTL = {
    id: 'minimaxintl',
    displayName: 'MiniMax Code (国际版)',
    accountHost: 'https://account.minimax.io',
    apiHost: 'https://agent.minimax.io',
    // ⚠️ 目录查询参数按站点不同：国内 `cn` / 国际 `en`（上游实现实测）。
    region: 'en',
    buildEnv: 'prod',
    clientId: 'mcode-public',
    audience: 'agent-backend',
    scope: 'agent.default',
    defaultCredentialRef: 'MINIMAXINTL_ACCESS_TOKEN',
    fallbackModels: MINIMAX_FALLBACK_MODELS,
    maxImageBytesInline: 10 * 1024 * 1024,
    maxRequestBodyBytes: 64 * 1024 * 1024,
};
/** 产品注册表（两个站点；顺序即 `minimaxProductById` 的查找顺序）。 */
export const ALL_MINIMAX_PRODUCTS = [MINIMAX, MINIMAX_INTL];
/**
 * 按 id 查产品配置；未知 id 返回 undefined。
 *
 * ⚠️ **不要用它做「站点分派」**：它按 provider id 查，而站点分派在双 id 方案下
 * 就是「按 provider id 查」本身 —— 调用方（`index.ts` / `jet-hub-rpc.ts`）
 * 各自持有自己那个实例，不需要在这里再查一次表。
 * 保留它只为「按 id 反查配置」这类诊断用途。
 */
export function minimaxProductById(id) {
    return ALL_MINIMAX_PRODUCTS.find((product) => product.id === id);
}
// ===== 端点路径 =====
/** OAuth 设备码申请（asar `endpoint-config.js`）。 */
export const MINIMAX_DEVICE_CODE_PATH = '/oauth2/device/code';
/**
 * 设备码**授权页**的服务端读接口（Gitee 反馈「链接自带旧登录态」的修法依据）。
 *
 * ## 为什么需要它（2026-10-24 实测）
 *
 * `verification_uri_complete`（`/oauth-authorize?user_code=…`）**不含任何身份**，
 * 身份全部来自浏览器 cookie —— 带已有会话打开就复用旧账号，用户看到的是
 * 「旧账号的授权页」。上游页面**不认**任何强制重新登录的参数（实测
 * `prompt=login` / `prompt=consent` / `prompt=select_account` / `force_login=1`
 * / `relogin=1` 五个参数：授权页 chunk 里这五个词命中数**全为 0**，只是被塞进
 * Next router 的 query）。
 *
 * 上游**自己**的「切换账号」按钮走的是这条端点：**不带 cookie** 请求时服务端恒回
 * `401 {"error":"login_required","login_url":"/unified-login?login_redirect=…"}`，
 * 而那个 `login_url` **自带 `login_redirect=<原授权页>`** ⇒ 用户在统一登录页
 * 登录完成后**自动回到授权页**并放行**新**账号。
 *
 * ⇒ 本端点让宿主可以**不依赖浏览器会话**地合成「保证走一遍登录」的链接，
 * 且**不触碰任何凭据**（纯 GET，无 `Authorization`）。
 *
 * ⚠️ 实测**不需要** `app_id`（带 `app_id=1` / `mcode-public` / `web` 与完全不带，
 * 四种形态响应逐字相同）。
 */
export const MINIMAX_DEVICE_AUTHORIZE_PATH = '/oauth2/device/authorize';
/**
 * 网页会话登出（「旧 session 掉登录状态」的兜底路径）。
 *
 * 实测：`GET https://account.minimax.cn/oauth2/logout` → `302 → /unified-login`
 * + `Set-Cookie: _sid=; path=/; HttpOnly; secure; SameSite=Lax`。
 *
 * ⚠️ **它不接受任何回跳参数**（实测 `redirect` / `redirect_url` / `return_to` /
 * `returnTo` / `url` / `service` / `target` / `to` / `continue` / `next_url` /
 * `next` 共 11 个参数，`Location` 恒为 `/unified-login`）⇒ 登出后**不会**自动
 * 回到授权页，必须由调用方再导航一次（配合 {@link MINIMAX_DEVICE_AUTHORIZE_PATH}
 * 合成的 `login_url` 正好构成两跳）。
 *
 * ⚠️⚠️ **作用域是整个 `account.minimax.cn` 网页会话** —— 用户日常浏览器里同一个
 * 域的 MiniMax 网页登录会被一起登出（与 officeace 的 `authui/logout` 同型副作用）。
 * 故它只作「无痕窗口不可用」时的**显式兜底**，且在 UI 上必须说明。
 */
export const MINIMAX_WEB_LOGOUT_PATH = '/oauth2/logout';
/** OAuth 令牌（轮询与续期共用）。 */
export const MINIMAX_TOKEN_PATH = '/oauth2/token';
/** OAuth 撤销。 */
export const MINIMAX_REVOKE_PATH = '/oauth2/revoke';
/** 远端模型目录（需 `?region=&buildEnv=`）。 */
export const MINIMAX_MODELS_PATH = '/mavis/api/v1/models';
/**
 * 推理路径（Anthropic Messages）。
 *
 * ⚠️ **本轮不发请求**（用户 2026-09-28 决定：账号余额不足，无法端到端验证）。
 * 常量保留供将来实现 `stream()` 时使用，并在文档里标注未实测。
 */
export const MINIMAX_INFER_PATH = '/mavis/api/v1/llm/v1/messages';
/** 签到状态（⚠️ 必须带 `?timezone_id=`）。 */
export const MINIMAX_SIGNIN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status';
/** 签到领取（⚠️ 必须带 `?timezone_id=`）。 */
export const MINIMAX_SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim';
/** 积分明细。 */
export const MINIMAX_CREDIT_DETAILS_PATH = '/minimax-cloud/api/v1/credit/details';
/** 请求超时（毫秒）。 */
export const MINIMAX_REQUEST_TIMEOUT_MS = 30_000;
/** OAuth 请求超时（毫秒）；比业务请求短，避免用户干等。 */
export const MINIMAX_OAUTH_TIMEOUT_MS = 20_000;
/**
 * 模型目录的**客户端**缓存期（远端 `ttlSeconds: 300`）。
 *
 * ⚠️ **当前仓库中无任何引用** —— 保留它是因为远端快照确实下发了 `ttlSeconds`，
 * 且这是将来实现「目录本地缓存」时该用的值。
 * 我们**不照抄**这么久的缓存（DSH 按需拉取目录），故实现缓存时也应重新评估。
 */
export const MINIMAX_MODEL_TTL_MS = 300_000;
//# sourceMappingURL=minimax-product.js.map