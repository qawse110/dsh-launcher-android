/**
 * TRAE（字节跳动 TRAE IDE）协议常量、凭据结构与请求转换。
 *
 * 本模块只放**常量与纯函数**，与 `src/buddy.ts` / `src/lobsterai.ts` 的角色一致。
 * 网络流程见：
 * - `src/trae-oauth.ts` —— 登录（ExchangeToken + GetUserInfo）
 * - `src/trae-auth.ts` —— 凭据服务（续期 / 状态）
 * - `src/trae-adapter.ts` —— chat 转发 + SSE 转换
 * - `src/trae-credits.ts` —— 签到与余额
 *
 * ## 协议速览（来源：trae2api 逆向分析）
 *
 * | 用途 | 方法 | 路径 | Host | 认证 |
 * |------|------|------|------|------|
 * | 对话 | POST | `/api/agent/v3/llm_utils_chat` | trae-api-cn.mchost.guru | Cloud-IDE-JWT |
 * | 模型列表 | POST | `/api/ide/v1/get_detail_param` | (同上) | Cloud-IDE-JWT |
 * | 换 token | POST | `/cloudide/api/v3/trae/oauth/ExchangeToken` | api.trae.com.cn | 无（用 refreshToken） |
 * | 用户信息 | POST | `/cloudide/api/v3/trae/GetUserInfo` | (同上) | Cloud-IDE-JWT |
 * | 签到状态 | POST | `/trae/api/v2/ug/checkin_credits/status` | api.trae.cn | Cloud-IDE-JWT |
 * | 签到领取 | POST | `/trae/api/v2/ug/checkin_credits/claim` | (同上) | Cloud-IDE-JWT |
 * | 积分余额 | POST | `/trae/api/v2/pay/ide_user_ent_usage` | (同上) | Cloud-IDE-JWT |
 *
 * 注意：chat 端点返回**自定义 SSE 事件格式**（非 OpenAI 标准），
 * 需要独立解析并转换为 OpenAI SSE。详见 `parseTraeSSELine` / `traeStreamToOpenAI`。
 *
 * ## 与现有 provider 的关键差异
 *
 * - **凭据带机器指纹**：`machine_id` / `device_id` 必须持久化，每次对话请求必须携带，
 *   且 `device_id` 签到不能共用（同一天两个账号共用同一 device_id 会被"该设备已签到"拦截）。
 * - **载荷必须转换**：OpenAI 的 `{model, messages, tools, tool_choice, stream}` 需要
 *   映射为 SOLO 格式（`function`, `config_name` 等字段），不能透传。
 * - **model 映射到 config_name**：并非直接用 model 值，需查远端模型列表做映射。
 *   Go 端 `handler.go:mapModel` 实现了 `__dev` 后缀去除、下划线→横线归一化、
 *   大小写不敏感匹配等逻辑。
 */
import { createHash } from 'node:crypto';
import { jwtExpiresAtMs } from './buddy.js';
import { TRAE_CHANNELS } from './trae-product.js';
// ── 端点路径 ──
/** 对话端点（SOLO 自定义 SSE）。 */
export const TRAE_CHAT_PATH = '/api/agent/v3/llm_utils_chat';
/** 模型列表（单通道）。 */
export const TRAE_MODELS_PATH = '/api/ide/v1/get_detail_param';
/**
 * 模型列表（**多通道**，真实 CN IDE 用的端点）。
 *
 * 一次请求传多个 `functions`，响应 `function_configs[]` 为**每个通道各自一套**
 * 模型目录 —— 用它替代逐个通道调用 `get_detail_param`。
 */
export const TRAE_BATCH_MODELS_PATH = '/api/ide/v1/batch_get_detail_param';
/** ExchangeToken（refreshToken 换 accessToken）。 */
export const TRAE_EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken';
/** 用户信息。 */
export const TRAE_USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo';
/** 签到状态。 */
export const TRAE_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
/** 签到领取。 */
export const TRAE_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';
/** 积分余额。 */
export const TRAE_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';
/** 登录回调路径（对齐 Go 端 `authorizeCallback` 与 TRAE 登录页强制回传）。 */
export const TRAE_CALLBACK_PATH = '/authorize';
/** 控制面请求超时（毫秒）；对话流式请求不适用。 */
export const TRAE_REQUEST_TIMEOUT_MS = 30_000;
/** 登录流程总超时（毫秒，对齐 Go 端 login timeout）。 */
export const TRAE_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// ── 过期时间与可刷新判定 ──
/**
 * 从凭据的 `expires_at` 解析毫秒时间戳。
 *
 * 兼容毫秒时间戳 / 秒级时间戳 / ISO 8601 三种形态，与
 * `src/buddy.ts:credentialExpiresAtMs` 的解析口径一致。
 *
 * 后备来源：`expires_at` 为空时回退解析 `access_token` 这个 JWT 的 `exp`。
 */
export function traeCredentialExpiresAtMs(credential) {
    const raw = credential.expires_at;
    if (typeof raw === 'string' && raw.length > 0) {
        if (/^\d+$/.test(raw)) {
            const value = Number(raw);
            return value > 1_000_000_000_000 ? value : value * 1000;
        }
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed))
            return parsed;
    }
    return jwtExpiresAtMs(credential.access_token);
}
/** 凭据是否已过期；无法解析过期时间时**不**判定过期。 */
export function isTraeExpired(credential) {
    const expiresAt = traeCredentialExpiresAtMs(credential);
    return expiresAt === undefined ? false : Date.now() >= expiresAt;
}
/** 凭据是否携带可静默续期的 refresh_token。 */
export function isTraeRefreshable(credential) {
    return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0;
}
// ── 请求头构造 ──
/**
 * 构造 SOLO 对话/模型列表请求头。
 *
 * 对齐 Go 端 `SOLOHeaders`（`headers.go:14-45`）。
 * 注意有多处设置相同的 token 值（Authorization / X-Cloudide-Token / X-Ide-Token），
 * 实测缺任一个都可能被上游拒绝。
 *
 * @param machineIdGeneration 机器指纹轮换代次（**默认 0 = 不轮换**）。
 *   仅当显式启用 `DSH_TRAE_ROTATE_MACHINE_ID=1` 时应为非 0，见
 *   {@link deriveRotatingMachineId} 对取舍的说明。
 */
export function traeSOLOHeaders(credential, product, stream, machineIdGeneration = 0) {
    const headers = {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        'User-Agent': product.userAgent,
        Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
        'X-Cloudide-Token': credential.access_token,
        'X-Ide-Token': credential.access_token,
        'X-Uid': credential.uid,
        'X-App-Id': product.appId,
        'X-App-Version': 'default',
        'X-Ide-Version': product.ideVersion,
        'X-Ide-Version-Code': product.ideVersionCode,
        'X-App-Version-Code': product.ideVersionCode,
        'X-Ide-Version-Type': 'stable',
        'X-Device-Type': 'macos',
        'X-OS-Version': product.osVersion,
        'X-Device-Brand': product.deviceBrand,
        'Request-Traffic-Type': 'prod',
    };
    if (credential.machine_id.length > 0) {
        headers['X-Machine-Id'] = deriveRotatingMachineId(credential.machine_id, machineIdGeneration);
    }
    if (credential.device_id.length > 0) {
        headers['X-Device-Id'] = credential.device_id;
    }
    return headers;
}
/**
 * 构造 Ug（签到/积分）请求头。
 *
 * 对齐 Go 端 `UgHeaders`（`headers.go:48-57`）。
 *
 * @param checkinDeviceGeneration 签到设备轮换代次（默认 0 = 用凭据原始
 *   `device_id`）。命中 9074 后传 `>0` 即可换到一个全新派生设备号绕开
 *   **设备级**限流（见 {@link deriveCheckinDeviceId}）。
 */
export function traeUgHeaders(credential, product, checkinDeviceGeneration = 0) {
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': product.userAgent,
        Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
        'X-User-Region': 'CN',
    };
    if (credential.device_id.length > 0) {
        headers['X-Device-Id'] = deriveCheckinDeviceId(credential.device_id, checkinDeviceGeneration);
    }
    return headers;
}
/**
 * 构造签到专用完整请求头（对齐 trae-mate 的 `build_headers`）。
 *
 * ## 与 `traeUgHeaders` 的关键区别
 *
 * trae-mate 实际签到成功使用的是一套**非常完整的客户端请求头**（约 20 个），
 * 而不仅仅是简化的 Ug 头。具体差异：
 *
 * - `X-Device-Id`：使用**基于 user_id 确定性派生的 15 位数字**，而非基于
 *   credential.device_id 的 32 hex。每个账号独享一套稳定设备身份。
 * - 新增 `X-Market-User-ID` / `X-Lscbd-Aid` / `X-Lgw-Req-Sdk-Type` /
 *   `Package-Type` / `X-Tt-Trace-Id` / `Vscode-Sessionid` 等头
 * - 每次请求生成独立的 `X-Request-Id` 与 `X-Tt-Trace-Id`
 *
 * @param userId 账号 user_id，用于确定性派生设备身份（每个账号独立）
 */
export function traeCheckinHeaders(credential, product, userId) {
    const deviceId = deriveDeviceId15(userId);
    const marketUserId = deriveMarketUserId(userId);
    const sessionId = deriveSessionId(userId);
    const traceId = `00-${randomHex(16)}-01`;
    const requestId = uuidV4();
    return {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'zh-CN',
        'User-Agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
        Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
        'X-Market-Client-Id': 'VSCode 1.107.1',
        'X-Market-User-Id': marketUserId,
        'X-User-Region': 'CN',
        'X-Device-Id': deviceId,
        'X-Lgw-Req-Sdk-Type': '3',
        'Package-Type': 'stable_cn',
        'X-Lscbd-Aid': '787976',
        'X-Lscbd-Platform': 'windows',
        'App-Version': product.ideVersion,
        'X-Tt-Trace-Id': traceId,
        'Vscode-Sessionid': sessionId,
        'X-Request-Id': requestId,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'none',
    };
}
// ── 签到设备身份确定性派生（对齐 trae-mate `device_map.rs`）──
/**
 * 确定性派生 15 位数字设备 ID（基于 user_id）。
 *
 * 每个账号基于其 user_id 永远得到同一套设备标识，使多账号签到各自携带独立
 * 设备身份，规避服务端"每设备每天一次"配额。
 */
function deriveDeviceId15(userId) {
    return seededDigits(15, userId, 'devid');
}
/**
 * 确定性派生 Market User ID（UUID v4，基于 user_id）。
 */
function deriveMarketUserId(userId) {
    const bs = seededStream(userId, 'market', 16);
    bs[6] = (bs[6] & 0x0F) | 0x40; // version 4
    bs[8] = (bs[8] & 0x3F) | 0x80; // variant RFC 4122
    const hex = bs.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
/**
 * 确定性派生 Session ID（64 位 hex，基于 user_id）。
 */
function deriveSessionId(userId) {
    const bytes = seededStream(userId, 'sess', 32);
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * SHA-256 确定性伪随机流。
 *
 * 输入 `(seed, salt)` 永远产生相同的输出序列。每个调用生成 `nbytes` 字节。
 * 算法：`SHA256(utf8(salt:seed) ++ counterBE32)` 串联直到达到 `nbytes`。
 */
function seededStream(seed, salt, nbytes) {
    const prefix = `${salt}:${seed}`;
    const result = [];
    let counter = 0;
    while (result.length < nbytes) {
        const counterBuf = new Uint8Array(4);
        counterBuf[0] = (counter >> 24) & 0xFF;
        counterBuf[1] = (counter >> 16) & 0xFF;
        counterBuf[2] = (counter >> 8) & 0xFF;
        counterBuf[3] = counter & 0xFF;
        const h = createHash('sha256');
        h.update(prefix, 'utf8');
        h.update(counterBuf);
        for (const b of h.digest()) {
            result.push(b);
            if (result.length >= nbytes)
                break;
        }
        counter++;
    }
    return result.slice(0, nbytes);
}
/**
 * 确定性派生 N 位数字字符串。
 */
function seededDigits(n, seed, salt) {
    const bs = seededStream(seed, salt, n);
    return bs.map((b) => (b % 10).toString()).join('');
}
/**
 * 生成 UUID v4（随机，非确定性）。
 */
function uuidV4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}
/**
 * 生成 N 位随机 hex 字符串。
 */
function randomHex(n) {
    const buf = new Uint8Array(Math.ceil(n / 2));
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
}
/**
 * 构造 OAuth（ExchangeToken / GetUserInfo）请求头。
 *
 * 对齐 Go 端 `OAuthHeaders`（`headers.go:60-64`）：无签名，仅 UA。
 * GetUserInfo 需要额外 `X-Cloudide-Token` 头，由调用方自行添加。
 */
export function traeOAuthHeaders(product) {
    return {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': product.userAgent,
    };
}
/**
 * 解析 ExchangeToken 响应。
 *
 * Go 端响应结构：`{ Result: { Token, TokenExpireAt, TokenExpireDuration, RefreshToken, RefreshExpireAt } }`
 */
export function parseTraeExchangeResponse(data) {
    const result = data.Result ?? data.result;
    if (typeof result !== 'object' || result === null)
        return undefined;
    const r = result;
    const accessToken = readStringField(r, 'Token') || readStringField(r, 'token') || readStringField(r, 'accessToken');
    const refreshToken = readStringField(r, 'RefreshToken') || readStringField(r, 'refreshToken');
    if (accessToken.length === 0)
        return undefined;
    return {
        accessToken,
        refreshToken,
        tokenExpireAt: readNumberField(r, 'TokenExpireAt') ?? readNumberField(r, 'tokenExpireAt') ?? 0,
        tokenExpireDuration: readNumberField(r, 'TokenExpireDuration') ?? readNumberField(r, 'tokenExpireDuration') ?? 0,
        refreshExpireAt: readNumberField(r, 'RefreshExpireAt') ?? readNumberField(r, 'refreshExpireAt') ?? 0,
    };
}
/**
 * 解析 GetUserInfo 响应。
 *
 * Go 端响应结构：`{ Result: { UserID, ScreenName, EnterpriseID, NonPlainTextMobile } }`
 *
 * ⚠️ `NonPlainTextMobile` 实测**确实下发**（2026-09-27 用四个真实账号核对
 */
export function parseTraeUserInfoResponse(data) {
    const result = data.Result ?? data.result;
    if (typeof result !== 'object' || result === null)
        return undefined;
    const r = result;
    const uid = readStringField(r, 'UserID') || readStringField(r, 'userId') || readStringField(r, 'uid');
    if (uid.length === 0)
        return undefined;
    return {
        uid,
        screenName: readStringField(r, 'ScreenName') || readStringField(r, 'screenName') || uid,
        enterpriseId: readStringField(r, 'EnterpriseID') || readStringField(r, 'enterpriseId') || '',
        // ⚠️ 字段名是 **NonPlainTextMobile / NonPlainTextEmail**（不是 Mobile /
        // Phone / Email）—— 实测 `GetUserInfo` 只下发这两个脱敏形态。
        phone: readStringField(r, 'NonPlainTextMobile') || readStringField(r, 'nonPlainTextMobile'),
        email: readStringField(r, 'NonPlainTextEmail') || readStringField(r, 'nonPlainTextEmail'),
    };
}
/**
 * 由 ExchangeToken 结果 + 用户信息组装凭据。
 *
 * `expires_at` 取值顺序（对齐 Go 端 `normalizeExpiresAt` / `refreshLocked`）：
 * 1. `tokenExpireAt`（绝对值，Go 端归一化为秒，这里再转毫秒）；
 * 2. `tokenExpireDuration`（相对秒数，以当前时刻为基准）；
 * 3. 都拿不到则留空（由 JWT exp 兜底）。
 *
 * `machine_id` / `device_id` 由调用方传入（它们在登录流程中生成，不在响应里）。
 */
export function buildTraeCredential(exchange, userInfo, session, nowMs = Date.now()) {
    // Go 端 normalizeExpiresAt：毫秒→秒；我们存毫秒，所以要 *1000。
    let expiresAt;
    if (exchange.tokenExpireAt > 1e12) {
        // 毫秒值（如 1786847930141）→ 直接写毫秒
        expiresAt = String(exchange.tokenExpireAt);
    }
    else if (exchange.tokenExpireAt > 0) {
        // 秒值（Go 端归一化后）→ 转毫秒
        expiresAt = String(exchange.tokenExpireAt * 1000);
    }
    else if (exchange.tokenExpireDuration > 0) {
        expiresAt = String(nowMs + exchange.tokenExpireDuration * 1000);
    }
    else {
        // 从 access_token JWT 兜底
        const exp = jwtExpiresAtMs(exchange.accessToken);
        expiresAt = exp === undefined ? '' : String(exp);
    }
    return {
        access_token: exchange.accessToken,
        refresh_token: exchange.refreshToken,
        expires_at: expiresAt,
        uid: userInfo.uid,
        nickname: userInfo.screenName,
        ...userInfo.phone.length > 0 ? { phone: userInfo.phone } : {},
        ...userInfo.email.length > 0 ? { email: userInfo.email } : {},
        machine_id: session.machineId,
        device_id: session.deviceId,
        enterprise_id: userInfo.enterpriseId,
    };
}
/**
 * 构造 TRAE 账号在 Jet Hub 里的**展示名**：手机号优先，缺失时回退 ScreenName。
 *
 * ## 为什么不是直接用 ScreenName（真实缺陷，用户报障 2026-09-27）
 *
 * > 用 trae provider 登录后用户名字显示无法区分各个用户，有其他名字昵称或者
 * > 手机尾号之类的信息可以区分吗？
 *
 * 根因：`ScreenName` 是字节 passport **按 uid 自动生成的默认名**
 * （`用户` + uid 片段）。实测四个账号分别是
 * `用户26815487395` / `用户9340371069` / `用户5061993825` / `用户86180215561`
 * —— 长度、形态完全一致，一屏列出来根本认不出谁是谁。
 * 这与 Raccoon 的 `RaccoonAva` 是同一类问题（那边用「名字 + 手机尾号」消歧）。
 *
 * 可用字段实测（2026-09-27，四个真实账号）：
 *
 * | 字段 | 值 | 可区分性 |
 * |---|---|---|
 * | `ScreenName` | `用户26815487395` 等 | ❌ 自动生成，形态雷同 |
 * | `NonPlainTextMobile` | `130******00` | ✅ 末两位互异 |
 * | `NonPlainTextEmail` | 全为空（`LastLoginType` 均为 `sms`） | ❌ 短信登录无邮箱 |
 * | `Description` | 全为空 | ❌ |
 * | `UserID` | `4056564292660009` 等 | ⚠️ 可区分但过长、不可读 |
 *
 * 故**取手机号优先**（用户明确要求的展示形态）：
 * 手机号 → 邮箱 → ScreenName → 账号 id。
 *
 * ⚠️ 手机号与邮箱都是**脱敏**形态，照原样展示即可，不要试图还原或截取后四位
 * —— 中间本就打码，`130******00` 整体已经足够短且可辨认。
 */
export function traeDisplayNickname(credential, fallbackId) {
    const phone = typeof credential?.phone === 'string' ? credential.phone.trim() : '';
    if (phone.length > 0)
        return phone;
    // 邮箱登录的账号没有手机号（`LastLoginType` 为 email），用脱敏邮箱兜底。
    const email = typeof credential?.email === 'string' ? credential.email.trim() : '';
    if (email.length > 0)
        return email;
    const nickname = typeof credential?.nickname === 'string' ? credential.nickname.trim() : '';
    if (nickname.length > 0)
        return nickname;
    const uid = typeof credential?.uid === 'string' ? credential.uid.trim() : '';
    return uid.length > 0 ? uid : fallbackId;
}
/**
 * 把脱敏手机号 / 邮箱写进凭据（返回新对象，不改原凭据）。
 *
 * 与 `withQoderNickname` 同因：账号条目会随 Jet Hub 的账号操作整体重写，
 * 而凭据里存一份才能在续期后（`applyTraeRefresh` 会保留它）与其它面板
 * （积分、模型）都稳定拿到。
 *
 * 空串与 undefined 均视为「没有」，此时**原样返回**（不写入空字段）。
 */
export function withTraePhone(credential, phone, email) {
    const hasPhone = phone !== undefined && phone.length > 0;
    const hasEmail = email !== undefined && email.length > 0;
    if (!hasPhone && !hasEmail)
        return credential;
    return {
        ...credential,
        ...hasPhone ? { phone } : {},
        ...hasEmail ? { email } : {},
    };
}
/**
 * 用续期结果更新凭据。
 *
 * ExchangeToken 响应会轮换 access_token 和 refresh_token。
 * 保留所有身份字段（machine_id / device_id / uid / nickname / enterprise_id）。
 */
export function applyTraeRefresh(previous, exchange, nowMs = Date.now()) {
    let expiresAt;
    if (exchange.tokenExpireAt > 1e12) {
        expiresAt = String(exchange.tokenExpireAt);
    }
    else if (exchange.tokenExpireAt > 0) {
        expiresAt = String(exchange.tokenExpireAt * 1000);
    }
    else if (exchange.tokenExpireDuration > 0) {
        expiresAt = String(nowMs + exchange.tokenExpireDuration * 1000);
    }
    else {
        const exp = jwtExpiresAtMs(exchange.accessToken);
        expiresAt = exp === undefined ? '' : String(exp);
    }
    return {
        ...previous,
        access_token: exchange.accessToken,
        // refresh_token 也会被轮换，新值不为空时才更新。
        refresh_token: exchange.refreshToken.length > 0 ? exchange.refreshToken : previous.refresh_token,
        expires_at: expiresAt,
    };
}
/**
 * 该条目是否**可调用**（本插件的硬性过滤）。
 *
 * 两个标志各自独立、都必须放行：
 * - `isCustomModel`：需用户在 IDE 内自行配置 → 本插件必然调不通（流内 `4001`）
 * - `isEnabled === false`：上游已停用
 *
 * 未声明（`undefined`）一律**放行**：宁可多留一个模型，也不要因缺字段误删整批。
 *
 * ⚠️ **`isHidden`（官方的 `is_invisible_to_user`）不在这里判定** —— 它表示
 * 「官方客户端的选择器不展示」，与「能不能调用」是**两个独立维度**。
 * 实测 `glm-5.1` 就是「可调用但被官方隐藏」：它在 `solo_agent_remote` 正常出
 * output，而官方 picker 不列它。把它并进可用性判定会连带删掉一批**能用的**
 * 模型（`glm-5-turbo` / `sagitta` / `qwen-3.5` …），所以它由调用方按需选择
 * （见 {@link isTraeModelUsable} 的 `hideInternal`）。
 */
export function isTraeModelCallable(model) {
    return model.isCustomModel !== true && model.isEnabled !== false;
}
/**
 * 该条目是否应出现在**模型目录**里。
 *
 * @param options.hideInternal 为 `true` 时连官方隐藏的条目一并剔除，
 *   使目录与真实 CN IDE 的选择器**完全一致**（但也因此看不到 `glm-5.1` 等
 *   可调用模型）。默认 `false`：只挡必然调不通的条目，其余交给用户的
 *   模型黑名单（Jet Hub「显示列表」）自行取舍。
 */
export function isTraeModelUsable(model, options = {}) {
    if (!isTraeModelCallable(model))
        return false;
    if (options.hideInternal === true && model.isHidden === true)
        return false;
    return true;
}
/** 读取 `context_window_tokens.dev`（缺失时回退 `max`）。 */
function readContextWindowField(entry) {
    const raw = entry.context_window_tokens ?? entry.ContextWindowTokens;
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    const value = readNumberField(record, 'dev')
        ?? readNumberField(record, 'Dev')
        ?? readNumberField(record, 'max')
        ?? readNumberField(record, 'Max');
    return value !== undefined && value > 0 ? Math.trunc(value) : undefined;
}
/**
 * 读取 `context_window_tokens.max`（Max 模式专用窗口，通常 1000000）。
 *
 * 与 {@link readContextWindowField} 分开：那个取 `dev`（默认可用），本函数取
 * `max`（仅开 Max 模式时可用）。两者绝不能混用 —— 把 `max` 当常规窗口声明
 * 会让 DSH 以为有 1M 上下文，而实际请求未开 Max 模式，上游按 200K 校验。
 */
function readMaxContextWindowField(entry) {
    const raw = entry.context_window_tokens ?? entry.ContextWindowTokens;
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    const value = readNumberField(record, 'max') ?? readNumberField(record, 'Max');
    return value !== undefined && value > 0 ? Math.trunc(value) : undefined;
}
/**
 * 读取 `model_detail_list[].max_tokens`。
 *
 * 多条明细时优先取 `model_name` 以 `preferredSuffix` 结尾的那条（对齐 upstream 的
 * `config_name__dev` / `config_name__max` 约定），否则取第一条。
 *
 * @param preferredSuffix 优先匹配的后缀，默认 `__dev`（常规模式）；传 `__max`
 *   即取 Max 模式那条明细的输出上限。
 */
function readDetailMaxTokens(entry, preferredSuffix = '__dev') {
    const raw = entry.model_detail_list ?? entry.ModelDetailList;
    if (!Array.isArray(raw) || raw.length === 0)
        return undefined;
    const details = raw.filter((item) => typeof item === 'object' && item !== null);
    const preferred = details.find((item) => readStringField(item, 'model_name').endsWith(preferredSuffix));
    const chosen = preferred ?? details[0];
    if (chosen === undefined)
        return undefined;
    const value = readNumberField(chosen, 'max_tokens') ?? readNumberField(chosen, 'MaxTokens');
    return value !== undefined && value > 0 ? Math.trunc(value) : undefined;
}
/**
 * 读取 `reasoning_effort_config`。
 *
 * 真实形状：`{ default_level, options: ["light","high","extra_high"], support_thinking }`。
 * `options` 同时兼容**字符串数组**（实测形态）与**对象数组**（`{level,...}`，
 * 防御性兼容 —— 若上游改成双字段形态也不会解析成空）。
 *
 * 一个字段都没有时返回 `undefined`（而不是空配置）：调用方据此不声明
 * `reasoning`，避免给用户一个发了也没用的档位选择器。
 */
function readReasoningEffortConfig(entry) {
    const raw = entry.reasoning_effort_config ?? entry.ReasoningEffortConfig;
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const record = raw;
    const options = [];
    const rawOptions = record.options ?? record.Options;
    if (Array.isArray(rawOptions)) {
        for (const item of rawOptions) {
            if (typeof item === 'string' && item.trim().length > 0) {
                options.push(item.trim());
            }
            else if (typeof item === 'object' && item !== null) {
                // 对象形态兜底：优先 wire 值 openclawLevel，其次产品侧 level。
                const obj = item;
                const wire = readStringField(obj, 'openclawLevel')
                    || readStringField(obj, 'level')
                    || readStringField(obj, 'Level');
                if (wire.trim().length > 0)
                    options.push(wire.trim());
            }
        }
    }
    const defaultLevel = readStringField(record, 'default_level')
        || readStringField(record, 'DefaultLevel');
    const supportThinking = readBooleanField(record, 'support_thinking')
        ?? readBooleanField(record, 'SupportThinking');
    if (options.length === 0 && defaultLevel.length === 0 && supportThinking === undefined) {
        return undefined;
    }
    return {
        options,
        ...defaultLevel.length > 0 ? { defaultLevel } : {},
        ...supportThinking === undefined ? {} : { supportThinking },
    };
}
/**
 * 解析 `display_contact_config` 里的**消耗倍率**。
 *
 * ## 为什么必须单独一个函数
 *
 * `display_contact_config` 是**一个 JSON 字符串**（不是对象）：
 * ```json
 * "{\"consumption_rate\":{\"enable\":true,\"data\":{\"rate\":0.08}},\"multimodal\":{...}}"
 * ```
 * 直接读 `entry.display_contact_config.consumption_rate` 永远得到 undefined。
 *
 * ## 三条判据（缺一不可）
 *
 * 1. `consumption_rate.enable !== false` —— 上游显式关闭时**不显示**，而不是当成 0；
 * 2. `data.rate` 是**有限非负数**（实测形态是裸数字 `0.08`，不是字符串 `"x0.08"`）；
 * 3. ⚠️ **`rate: 0` 是合法值**（免费），不能用 `> 0` 过滤 —— 这条与 Qoder 的
 *    `price_factor: 0` 一致，是「恰好漏掉用户最关心的免费模型」的经典坑。
 *
 * 解析失败一律返回 undefined（**不编造倍率**：宁可只显示模型名）。
 */
export function readConsumptionRate(entry) {
    const raw = entry.display_contact_config ?? entry.DisplayContactConfig;
    if (typeof raw !== 'string' || raw.length === 0)
        return undefined;
    const config = parseJsonObject(raw);
    if (config === undefined)
        return undefined;
    const rate = config.consumption_rate ?? config.ConsumptionRate;
    if (typeof rate !== 'object' || rate === null)
        return undefined;
    const rateRecord = rate;
    if (readBooleanField(rateRecord, 'enable') === false)
        return undefined;
    const data = rateRecord.data ?? rateRecord.Data;
    if (typeof data !== 'object' || data === null)
        return undefined;
    const value = readNumberField(data, 'rate');
    return value !== undefined && value >= 0 ? value : undefined;
}
/**
 * 解析 `activity_discount` —— 只在**当前确实生效**时返回原价与截止时间。
 *
 * ## 为什么不能只看 `enable: true`
 *
 * 实测陷阱：`enable` 为 `true` 但**当前并没有折扣**。`off_peak` 型条目形如
 * `{type:"none", before:0.13, after:0.13, discount:100}` —— `discount: 100`
 * 表示「无折扣」（百分比制），`before === after`。若照显会显示
 * `x0.13→x0.13`，让用户以为有活动。这与 Qoder 的 `promotion.active === false`
 * 是同类语义，处理方式也必须一致：**不展示**。
 *
 * 三条判据：
 * 1. `activity_discount.enable !== false`；
 * 2. `data.current` 存在，且 `discount_type` **不是 `"none"`**；
 * 3. `before_consumption_rate` 是有限正数，且**严格大于** `after`（真正的降价）。
 *
 * `end_at`（Unix 秒）仅 `limited` 型带；**已过期**时整个折扣视为不存在 ——
 * 否则用户会按折扣价预期、实际被按原价计费。
 */
export function readActivityDiscount(entry, nowSec = Math.floor(Date.now() / 1000)) {
    const raw = entry.display_contact_config ?? entry.DisplayContactConfig;
    if (typeof raw !== 'string' || raw.length === 0)
        return undefined;
    const config = parseJsonObject(raw);
    if (config === undefined)
        return undefined;
    const discount = config.activity_discount ?? config.ActivityDiscount;
    if (typeof discount !== 'object' || discount === null)
        return undefined;
    const discountRecord = discount;
    if (readBooleanField(discountRecord, 'enable') === false)
        return undefined;
    const data = discountRecord.data ?? discountRecord.Data;
    if (typeof data !== 'object' || data === null)
        return undefined;
    const dataRecord = data;
    const current = dataRecord.current ?? dataRecord.Current;
    if (typeof current !== 'object' || current === null)
        return undefined;
    const currentRecord = current;
    // `discount_type: "none"` = 当前无活动（实测 off_peak 型即为此）。
    const type = (readStringField(currentRecord, 'discount_type')
        || readStringField(currentRecord, 'discountType')).trim().toLowerCase();
    if (type.length === 0 || type === 'none')
        return undefined;
    const before = readNumberField(currentRecord, 'before_consumption_rate')
        ?? readNumberField(currentRecord, 'beforeConsumptionRate');
    const after = readNumberField(currentRecord, 'consumption_rate')
        ?? readNumberField(currentRecord, 'consumptionRate');
    // 必须是真的降价：before 有值、为正、且严格大于 after。
    if (before === undefined || before <= 0)
        return undefined;
    if (after !== undefined && before <= after)
        return undefined;
    // 截止时间：取 data 下任意带 end_at 的子对象（limited / 未来的新活动类型）。
    let endsAtSec;
    for (const value of Object.values(dataRecord)) {
        if (typeof value !== 'object' || value === null)
            continue;
        const end = readNumberField(value, 'end_at')
            ?? readNumberField(value, 'endAt');
        if (end !== undefined && end > 0) {
            endsAtSec = end;
            break;
        }
    }
    // 已过期的活动不再是「当前生效」。
    if (endsAtSec !== undefined && endsAtSec <= nowSec)
        return undefined;
    return endsAtSec === undefined ? { originalRate: before } : { originalRate: before, endsAtSec };
}
/** 宽松解析 JSON 对象字符串；非对象（数组/标量/非法 JSON）返回 undefined。 */
function parseJsonObject(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/** 解析单条 `config_info_list` 条目（两个端点的条目形状一致）。 */
function parseTraeConfigEntry(entry, channel) {
    const id = readStringField(entry, 'config_name') || readStringField(entry, 'ConfigName');
    if (id.length === 0)
        return undefined;
    const display = entry.display_config ?? entry.DisplayConfig;
    const displayRecord = typeof display === 'object' && display !== null
        ? display
        : undefined;
    const name = displayRecord !== undefined
        ? readStringField(displayRecord, 'display_name') || id
        : id;
    // 所有标志「上游没说」都保持 undefined（不填 false）：过滤方只挡明确命中者。
    const isCustomModel = displayRecord === undefined
        ? undefined
        : readBooleanField(displayRecord, 'is_custom_model')
            ?? readBooleanField(displayRecord, 'IsCustomModel');
    const isHidden = readBooleanField(entry, 'is_invisible_to_user')
        ?? readBooleanField(entry, 'IsInvisibleToUser');
    const isEnabled = readBooleanField(entry, 'config_switch')
        ?? readBooleanField(entry, 'ConfigSwitch');
    const usage = readStringField(entry, 'usage') || readStringField(entry, 'Usage');
    const contextWindow = readContextWindowField(entry);
    const maxOutputTokens = readDetailMaxTokens(entry);
    // Max 模式三件套：开关 / 1M 窗口 / Max 那条明细的输出上限。
    const maxMode = displayRecord === undefined
        ? undefined
        : readBooleanField(displayRecord, 'max_mode')
            ?? readBooleanField(displayRecord, 'MaxMode');
    const maxContextWindow = readMaxContextWindowField(entry);
    const maxModeOutputTokens = readDetailMaxTokens(entry, '__max');
    // 图片能力（逐模型，见 `TraeRemoteModel.multimodal` 的说明）。
    // `multimodal` 与 `tool_response_multimodal` 是**两个独立字段**，不可合并。
    const multimodal = displayRecord === undefined
        ? undefined
        : readBooleanField(displayRecord, 'multimodal')
            ?? readBooleanField(displayRecord, 'Multimodal');
    const toolResponseMultimodal = displayRecord === undefined
        ? undefined
        : readBooleanField(displayRecord, 'tool_response_multimodal')
            ?? readBooleanField(displayRecord, 'ToolResponseMultimodal');
    const reasoningConfig = readReasoningEffortConfig(entry);
    // 计费：`display_contact_config` 里的倍率与活动折扣（两次 JSON.parse）。
    const creditsRate = readConsumptionRate(entry);
    const discount = readActivityDiscount(entry);
    return {
        id,
        name,
        ...channel === undefined ? {} : { function: channel },
        ...isCustomModel === undefined ? {} : { isCustomModel },
        ...isHidden === undefined ? {} : { isHidden },
        ...isEnabled === undefined ? {} : { isEnabled },
        ...usage.length > 0 ? { usage } : {},
        ...reasoningConfig === undefined ? {} : { reasoningConfig },
        ...maxMode === undefined ? {} : { maxMode },
        ...multimodal === undefined ? {} : { multimodal },
        ...toolResponseMultimodal === undefined ? {} : { toolResponseMultimodal },
        ...maxContextWindow === undefined ? {} : { maxContextWindow },
        ...maxModeOutputTokens === undefined ? {} : { maxModeOutputTokens },
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxOutputTokens === undefined ? {} : { maxOutputTokens },
        ...creditsRate === undefined ? {} : { creditsRate },
        ...discount === undefined ? {} : { originalCreditsRate: discount.originalRate },
        ...discount?.endsAtSec === undefined ? {} : { discountEndsAtSec: discount.endsAtSec },
    };
}
/**
 * 解析 `get_detail_param`（单通道）响应。
 *
 * Go 端响应结构：`{ config_info_list: [{ config_name, display_config: { display_name }, model_detail_list: [...] }] }`
 */
export function parseTraeModelList(body) {
    if (typeof body !== 'object' || body === null)
        return [];
    const record = body;
    const list = record.config_info_list ?? record.ConfigInfoList ?? record.data;
    if (!Array.isArray(list))
        return [];
    const models = [];
    for (const item of list) {
        if (typeof item !== 'object' || item === null)
            continue;
        const model = parseTraeConfigEntry(item, undefined);
        if (model !== undefined)
            models.push(model);
    }
    return models;
}
/**
 * 解析 `batch_get_detail_param`（**多通道**）响应。
 *
 * 真实 CN IDE 用的就是这个端点：一次请求传 22 个 `functions`，响应形如
 * `{ function_configs: [{ function, config_info_list: [...] }, …] }`，
 * **每个 function 各自一套模型目录**。实测（2026-09-19，7 个对话通道）：
 *
 * | function | 总 | 可用 |
 * |---|---|---|
 * | `solo_agent` | 66 | 34 |
 * | `solo_agent_remote` / `solo_agent_lite` | 44 | 29 |
 * | `solo_work_remote` / `solo_work_lite` | 44 / 45 | 28 |
 * | `solo_design_remote` / `solo_design_lite` | 27 / 28 | 19 |
 *
 * 合并规则（**修正后**，见 issue IKI7WT/IKILR7「模型缺少思考强度」）：同一个
 * `config_name` 出现在多个 function 中时，按下列优先级取**一条**条目——
 *
 * 1. **空档位不得覆盖有档位**：候选与已选条目各自「能否声明出思考档位」由
 *    {@link declaresReasoningOptions} 判定（与 `TraeAdapter.reasoningFor` 同一判据）。
 *    已选条目有档位而候选没有时**保留已选条目**。
 * 2. **两侧都声明档位时按 `channelPriority` 取更靠前者**（默认
 *    {@link TRAE_CHANNELS}，「顺序即优先级」）。
 * 3. **其余情形保持既有「后覆盖前」语义**（含两侧都无档位），以免造成与本
 *    缺陷无关的通道迁移。
 *
 * ⚠️ 原实现是**无条件「后面的覆盖前面的」**，其注释假设「后面的条目带着更完整的
 * 配置」——**该假设与真实数据相反**：上游把空档位的 `solo_work_lite` /
 * `solo_design_remote` 等条目排在**最后**，于是信息更全的条目被覆盖成更空的条目。
 * 实测（2026-09-26）13 个模型因此丢掉 `reasoning_effort_config`，
 * `deepseek-v4.1-flash` / `glm-5.2` / `DeepSeek-V4-Pro` 等全部显示「未提供推理等级」。
 *
 * ⚠️ **档位必须与 `function` 同源**：发档位的通道必须正是声明支持它的通道，
 * 否则上游按 `support_thinking:false` 处理（甚至回流内 4001）。故这里整条择优，
 * 而不是把 `reasoningConfig` 单独搬运到另一条条目上。
 *
 * 候选始终只来自**列出了该模型的通道**，因此无论选中哪条，都不会路由到
 * 「未列出该模型」的通道（上游对那种请求回流内 4001）。
 *
 * 同时四条硬性过滤在合并时执行：
 *
 * - **`function` 不在 `channelPriority`（可调用通道白名单）内**的整组跳过
 * - `usage` 非 `chat_completion` 的排除
 * - `config_switch === false`（上游已停用）排除
 * - `is_invisible_to_user === true`（官方隐藏）排除
 *
 * ⚠️ **第一条是 Issue IKJOZ7 的修复点**：`channelPriority` 此前**只用于排序**
 * （规则 2 的择优），不参与准入 —— 于是「目录声明了什么通道，就照着发什么通道」，
 * 而 22 个 function 里有一半在本插件的推理端点下不可调用（实测 `chat` →
 * `4023 the model is unknown`、`builder` → `4001 param is invalid`、
 * `inline_chat` → `3003 model service is unavailable`）。用户选中那些模型必然
 * 失败，且错误文案指向**模型**、极易被误判成「这个模型坏了」。
 * 现在它**同时是白名单**：不在表内的通道**整个丢弃**（连同其独有模型）。
 *
 * ⚠️ **丢弃是刻意的取舍**：`glm-5.1` / `DeepSeek-V4-Flash` 等模型同时也在通用
 * 通道（`solo_agent` 等）里，故它们**不受影响**；只有「仅在不可调用通道里出现」
 * 的条目（如 `kimi-k2` 仅见于 `inline_chat`）会被剔除 —— 那正是必然失败的那批。
 *
 * @param channelPriority **可调用通道白名单**，下标越小优先级越高。同时承担
 *   两个职责：不在表内的通道被丢弃；同一模型被多个表内通道列出时取更靠前者。
 *   覆盖它会改变**准入集合**，不只是顺序。
 */
export function parseTraeBatchModelList(body, channelPriority = TRAE_CHANNELS) {
    if (typeof body !== 'object' || body === null)
        return [];
    const record = body;
    const groups = record.function_configs ?? record.FunctionConfigs;
    if (!Array.isArray(groups))
        return [];
    /** 通道优先级下标（同样即白名单成员资格；非成员返回 -1 由调用处丢弃）。 */
    const rankOf = (channel) => channelPriority.indexOf(channel);
    const byId = new Map();
    /** 已选条目所在通道的优先级（仅用于规则 2 的择优）。 */
    const chosenRank = new Map();
    for (const group of groups) {
        if (typeof group !== 'object' || group === null)
            continue;
        const g = group;
        const channel = readStringField(g, 'function') || readStringField(g, 'Function');
        // ⚠️ 白名单准入（Issue IKJOZ7）：未声明的通道、以及**不在白名单内的通道**
        // 整组跳过 —— 后者的模型发出去必然被上游拒（判据见本函数注释的实测表）。
        // 未声明 `function` 的组同样跳过：无通道可用时无法构造合法请求，
        // 让它进目录只会变成一个「能选中但发不出去」的条目。
        if (channel.length === 0 || rankOf(channel) < 0)
            continue;
        const list = g.config_info_list ?? g.ConfigInfoList;
        if (!Array.isArray(list))
            continue;
        for (const item of list) {
            if (typeof item !== 'object' || item === null)
                continue;
            const model = parseTraeConfigEntry(item, channel);
            if (model === undefined)
                continue;
            // ⚠️ 硬性过滤：三条独立条件，缺一不可，不设外部开关。只在此处（batch 端点
            // 解析时）执行，单通道的 `get_detail_param` 已按场景筛选过，不需要。
            //
            // 1. usage 必须是 `chat_completion`：batch 端点是全功能配置表，包含
            //    summary / fast_apply / custom_model / multimodal 等非对话用途条目，
            //    混入目录会塞满无关模型；
            // 2. config_switch 必须开启：上游已停用；
            // 3. is_invisible_to_user 不得为 true：截图 Auto Mode 的模型列表只展示
            //    用户可见的条目（内部子代理、标题生成等不应出现在对话面板中）。
            if (model.usage !== undefined && model.usage !== 'chat_completion')
                continue;
            if (model.isEnabled === false)
                continue;
            if (model.isHidden === true)
                continue;
            const incumbent = byId.get(model.id);
            if (incumbent === undefined) {
                byId.set(model.id, model);
                chosenRank.set(model.id, rankOf(channel));
                continue;
            }
            // ⚠️ 规则 1 与 2，详见函数注释（issue IKI7WT/IKILR7）。
            const incumbentHasEffort = declaresReasoningOptions(incumbent);
            const candidateHasEffort = declaresReasoningOptions(model);
            // 规则 1：空档位不得覆盖有档位。
            if (incumbentHasEffort && !candidateHasEffort)
                continue;
            // 规则 2：两侧都有档位时按通道优先级取更靠前者（档位与 function 同源）。
            if (incumbentHasEffort && candidateHasEffort) {
                // ⚠️ 这里不再需要「已选条目不在优先级表内」的兜底分支（Issue IKJOZ7）：
                // 白名单准入已在上面跳过非白名单通道，故 `chosenRank` 与 `rankOf` 恒为
                // 0..n-1 的合法下标，不存在 `MAX_SAFE_INTEGER`。旧代码那套兜底是
                // 「优先级表只用于排序」时代的产物，现在是**不可达**的。
                if (rankOf(channel) >= (chosenRank.get(model.id) ?? 0))
                    continue;
            }
            // 规则 3：其余情形沿用既有的「后覆盖前」。
            byId.set(model.id, model);
            chosenRank.set(model.id, rankOf(channel));
        }
    }
    return [...byId.values()];
}
/**
 * 该条目**能否真正声明出思考档位**。
 *
 * 判据必须与 `TraeAdapter.reasoningFor` 完全一致（配置存在 + 未显式
 * `support_thinking: false` + `options` 非空）。⚠️ 只判「配置存在」是不够的：
 * `{support_thinking: false, options: []}` 与 `{support_thinking: false,
 * options: ['high']}` 都「存在配置」，但前者在适配器里仍会返回 `undefined`
 * （UI 依旧显示「未提供推理等级」）——若按「存在即优先」合并，就会选中这种
 * 条目、等于没修。
 */
function declaresReasoningOptions(model) {
    const config = model.reasoningConfig;
    if (config === undefined)
        return false;
    if (config.supportThinking === false)
        return false;
    return config.options.length > 0;
}
// ── 身份 ID 与随机值生成 ──
/**
 * 生成 32 位 hex 字符的 machine_id。
 *
 * 对齐 Go 端 `randomHex(16)` → 16 字节 → 32 hex 字符。
 * 登录时生成并持久化，不可每次重新生成。
 */
export function generateMachineId() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * 生成 32 位 hex 字符的 `device_id`。
 *
 * 对齐 `login.sh:34`：`DEVICE_ID="$(openssl rand -hex 16)"` —— **hex32**，
 * 与 `machine_id` 同格式。
 *
 * ⚠️ 早期实现错误地生成了「16 位纯数字」（那是 CodeBuddy 的签到设备号格式），
 * 与 TRAE 协议不符：该值会随登录 URL 的 `device_id` / `x_device_id` 一起下发，
 * 也会写进凭据并用于签到请求的 `X-Device-Id` 头。
 *
 * 每个账号必须互不相同 —— 同一天两个账号共用会被「该设备已签到」拦截。
 */
export function generateDeviceId() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * 由「基础 device_id + 代次」派生**签到专用**的设备号（hex32）。
 *
 * ## 为什么需要轮换（对齐 `Trae2api-cn/src/trae_client.py:443-466`）
 *
 * 业务码 **9074**（"too many users, retry later"）的限流范围是
 * **device_id 而非账号**：实测同一个账号在某个 id 上签到返回 9074 后，
 * 换一个**全新派生**的 id 立刻就能签到成功。
 *
 * 因此命中 9074 时不应该是死局 —— 把代次 +1 派生一个新设备号即可绕开。
 *
 * ## 为什么是「派生」而不是「重新随机」
 *
 * 派生的结果由 `(device_id, generation)` **唯一决定**，因此：
 * - 同一代次在任意进程/重启后都得到同一个值，无需持久化新 id 本身；
 * - 只需持久化一个整数代次（`traeCheckinDeviceGeneration`），凭据本体不动
 *   —— 避免为了签到去改写 `ctx.credentials` 里的登录凭据。
 *
 * ⚠️ **必须截断到 32 位 hex**：TRAE 的 `device_id` 是 `openssl rand -hex 16`
 * 的产物（16 字节 → **32** 个 hex 字符）。`sha256().digest('hex')` 直接给的是
 * **64** 字符，原样发出会与协议格式不符；取前 32 字符即等价于「16 字节哈希」。
 *
 * `generation <= 0` 时**原样返回**基础 id：既有账号（无该字段）行为完全不变。
 *
 * @param baseDeviceId 登录时生成并持久化的 device_id
 * @param generation 轮换代次（0 = 用原始 id）
 */
export function deriveCheckinDeviceId(baseDeviceId, generation) {
    if (!Number.isFinite(generation) || generation <= 0)
        return baseDeviceId;
    return createHash('sha256')
        .update(`${baseDeviceId}#gen${Math.floor(generation)}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
}
/**
 * 由「基础 machine_id + 代次」派生一个轮换用的机器指纹（hex32）。
 *
 * ## ⚠️ 默认关闭，这是**降风控**与**身份稳定**之间的权衡开关
 *
 * `Trae2api-cn/src/trae_client.py:211-224` 每 3~5 次请求主动换一次
 * `machine_id`，理由是「降低 IDE 端点风控」。但它换来抗风控的**代价**是
 * 设备身份漂移：上游按 `machine_id` 标识设备，换值可能触发重新登录或
 * 被判定为异常设备。
 *
 * 本项目的既定约束是「`machine_id` 登录时生成后**绝不重新生成**」
 * （见 `AGENTS.md` 与 `TraeCredential.machine_id` 注释），因此该能力
 * **默认关闭**，仅在显式设 `DSH_TRAE_ROTATE_MACHINE_ID=1` 时启用 ——
 * 若出现集中的 401/风控，这就是第一个可以尝试的开关。
 *
 * 同样截断到 32 位 hex（与 `machine_id` 的 hex32 格式一致）。
 *
 * `generation <= 0` 时原样返回基础 id。
 */
export function deriveRotatingMachineId(baseMachineId, generation) {
    if (!Number.isFinite(generation) || generation <= 0)
        return baseMachineId;
    return createHash('sha256')
        .update(`${baseMachineId}#machine${Math.floor(generation)}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
}
/**
 * 单次请求输出额度的**安全上限**（对齐 `Trae2api-cn/src/model_limits.py:9-23`）。
 *
 * 该项目实测结论：Trae SOLO CN 的 agent-remote 模型单次响应上限为
 * **64000 tokens**（`solo_agent_remote max_tokens=64000`），并明确写道：
 *
 * > Keep the local clamp below that ceiling so a client asking for 131072
 * > cannot push an upstream 4xx.
 *
 * 即：客户端索要 131072 会把上游直接打成 4xx。这里默认按同一口径收敛，
 * 但**保留环境变量覆盖**（`DSH_TRAE_MAX_COMPLETION_TOKENS`）—— 因为本 provider
 * 走的是 `solo_work_lite` 通道，与 CN 项目实测的 `solo_agent_remote` 未必同限，
 * 若实测证明可放开，调大或设为 0（关闭收敛）即可，无需改代码。
 */
export const TRAE_DEFAULT_MAX_COMPLETION_TOKENS = 64_000;
/** 解析输出额度上限：环境变量覆盖 > 默认 64000；显式 0 表示不收敛。 */
export function resolveTraeMaxCompletionTokens() {
    const raw = Number.parseInt(process.env.DSH_TRAE_MAX_COMPLETION_TOKENS ?? '', 10);
    if (Number.isFinite(raw) && raw >= 0)
        return raw;
    return TRAE_DEFAULT_MAX_COMPLETION_TOKENS;
}
/**
 * 把请求的输出额度收敛到安全上限。
 *
 * 只收敛**正整数**；`undefined` / 非法值原样返回（不编造数值）。
 */
export function clampTraeMaxTokens(value, limit = resolveTraeMaxCompletionTokens()) {
    if (value === undefined || !Number.isFinite(value) || value <= 0)
        return value;
    if (limit <= 0)
        return value;
    return Math.min(value, limit);
}
// ── JSON 安全读取 ──
/** 从 JSON 安全读取字符串字段（兼容后端把数字返回成 number）。 */
export function readStringField(source, key) {
    const value = source[key];
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return '';
}
/** 从 JSON 安全读取数字字段（兼容字符串形态的数字）。 */
export function readNumberField(source, key) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()))
        return Number(value);
    return undefined;
}
/**
 * 从 JSON 安全读取布尔字段。
 *
 * 只有**明确**的布尔语义才返回值：字段缺失返回 `undefined`（「上游没说」与
 * 「上游说 false」是两回事，调用方据此决定是否过滤）。不接受任意 truthy 值 ——
 * 例如空字符串在 JS 里是 falsy，但把它当成 `false` 会是一个没有依据的断言。
 */
export function readBooleanField(source, key) {
    const value = source[key];
    if (typeof value === 'boolean')
        return value;
    if (value === 1 || value === 'true')
        return true;
    if (value === 0 || value === 'false')
        return false;
    return undefined;
}
// ── OpenAI → SOLO 载荷转换 ──
/**
 * 默认 model（config_name）。
 * 对齐 Go 端 `DefaultConfigName = "glm-5.2"`。
 */
export const TRAE_DEFAULT_MODEL = 'glm-5.2';
/**
 * SOLO 对话 function 名称。
 * 对齐 Go 端 `Function = "solo_work_lite"`。
 * 实测：其他值（`work` / `solo` / `work_lite`）均无效。
 */
export const TRAE_FUNCTION = 'solo_work_lite';
// ── Max 模式（1M 上下文）──
/**
 * Max 模式的上下文窗口默认值（1M）。
 *
 * 显式开了 Max 模式的模型由远端 `context_window_tokens.max` 权威声明；
 * 该常量只在远端未声明时兜底。
 */
export const TRAE_MAX_CONTEXT_TOKENS = 1_000_000;
/**
 * Max 模式的提示词预算（936K）。
 *
 * 对齐 `Trae2api-cn/src/trae_remote_client.py:36` 的 `DEFAULT_MAX_PROMPT_TOKENS`：
 * 1M 总窗口里留给补全的部分，比总窗口小是刻意的（给输出留位）。
 */
export const TRAE_MAX_PROMPT_TOKENS = 936_000;
/** Max 模式的输出上限（64K），同上文件的 `DEFAULT_MAX_OUTPUT_TOKENS`。 */
export const TRAE_MAX_OUTPUT_TOKENS = 64_000;
/** Max 模式的 `mode_type` 取值（同上文件的 `DEFAULT_MAX_MODE_TYPE`）。 */
export const TRAE_MAX_MODE_TYPE = 1;
/**
 * 构造把远程会话钉到 **Max 模式**（1M 上下文）的 wire 字段。
 *
 * 对齐 `Trae2api-cn/src/trae_remote_client.py:356-397` 的 `_max_mode_fields`。
 * 实测要点：
 *
 * - ⚠️ **不能只调大 `max_tokens`**：上游按 `strategy=max` +
 *   `model_auto_selection.strategy=max` 判定「这是一个 Max 会话」，缺了它们
 *   只会被当成普通会话、按 200K 校验，然后拒绝 1M 的输入。
 * - `context_window_size` / `prompt_max_tokens` / `max_tokens` 三者要**成套**
 *   下发，远端按它们做准入校验（只发其中一个等于没发）。
 * - 只有远端明确标了 `display_config.max_mode === true` 的模型才能用；
 *   给未标记的模型硬套 Max 参数会被上游拒绝（见 `_max_mode_requested`）。
 *
 * @param maxContext 该模型声明的 Max 窗口（远端 `context_window_tokens.max`）
 * @param outputMax Max 模式下的输出上限；缺省用 {@link TRAE_MAX_OUTPUT_TOKENS}
 */
export function traeMaxModeFields(maxContext, outputMax) {
    const context = maxContext > 0 ? maxContext : TRAE_MAX_CONTEXT_TOKENS;
    return {
        model_auto_selection: {
            strategy: 'max',
            fallback_to_advance_model: null,
            entitlement_id: null,
        },
        model_selection_strategy: 'max',
        mode_type: TRAE_MAX_MODE_TYPE,
        context_window_size: context,
        prompt_max_tokens: TRAE_MAX_PROMPT_TOKENS,
        max_tokens: outputMax !== undefined && outputMax > 0 ? outputMax : TRAE_MAX_OUTPUT_TOKENS,
    };
}
/**
 * 将 OpenAI 格式的请求体转换为 SOLO 格式。
 *
 * 对齐 Go 端 `payload.go:PrepareBody` 的全部改写规则：
 * 1. messages.content 字符串 → `[{type:"text",text:...}]`；已经是数组 → 透传
 * 2. stream: 强制 true（非流式由服务端聚合）
 * 3. model → config_name + model（双字段）
 * 4. function: 取 `channel`，缺省 `"solo_work_lite"`
 * 5. tools/tool_choice: 归一化（"none" 删 tools；auto/required 保留；function 提取 name）
 * 6. assistant 消息中的 tool_calls: function → function_call（SOLO 字段名）
 * 7. tools 的 parameters: object → JSON string（SOLO 要求）
 *
 * @param openaiBody 原始的 OpenAI 请求体
 * @param modelMapping model → config_name 映射（可选，缺失时直接用 model 值）
 * @param channel 聊天通道（`function`）。**同一模型只在列出它的通道里可调用**，
 *   故必须传入该模型所属通道；缺省回退 {@link TRAE_FUNCTION}。
 * @returns 转换后的 SOLO 请求体
 */
export function transformToSOLOBody(openaiBody, modelMapping, channel) {
    const body = {
        ...openaiBody,
        stream: true,
        function: channel !== undefined && channel.length > 0 ? channel : TRAE_FUNCTION,
    };
    // ── messages 转换 ──
    const msgs = body.messages;
    if (Array.isArray(msgs)) {
        body.messages = msgs.map((msg) => transformSOLOMessage(msg));
    }
    // ── model → config_name + model ──
    const model = typeof body.model === 'string' ? body.model : '';
    // 支持 __dev 后缀消除
    const baseModel = model.includes('__') ? model.split('__')[0] : model;
    const configName = (modelMapping && modelMapping.length > 0) ? modelMapping : (baseModel || TRAE_DEFAULT_MODEL);
    body.config_name = configName;
    body.model = configName;
    // ── tool_choice 归一化 ──
    normalizeToolChoice(body);
    // ── tools.parameters 序列化 ──
    normalizeTools(body);
    return body;
}
/**
 * 转换单条消息（递归处理消息内容）。
 */
function transformSOLOMessage(msg) {
    const result = { ...msg };
    // assistant 消息的 tool_calls: function → function_call
    if (result.role === 'assistant') {
        const tcs = result.tool_calls;
        if (Array.isArray(tcs)) {
            const kept = [];
            for (const tc of tcs) {
                if (typeof tc !== 'object' || tc === null)
                    continue;
                const t = tc;
                // 把 function → function_call
                if (typeof t.function === 'object' && t.function !== null) {
                    t.function_call = t.function;
                    delete t.function;
                }
                // 无 function_call.name 的 tool_call 剔除
                const fc = t.function_call;
                if (fc === undefined || typeof fc.name !== 'string' || fc.name.trim().length === 0)
                    continue;
                kept.push(t);
            }
            if (kept.length > 0) {
                result.tool_calls = kept;
            }
            else {
                delete result.tool_calls;
            }
        }
    }
    // content 转换：字符串 → [{type:"text",text:...}]
    const content = result.content;
    if (content === null || content === undefined) {
        // 无 content 的消息（如纯 tool_calls assistant）跳过
    }
    else if (typeof content === 'string') {
        result.content = [{ type: 'text', text: content }];
    }
    // 已经是数组 → 透传（兼容多模态）
    return result;
}
/**
 * tool_choice 归一化。
 *
 * 对齐 Go 端 `normalizeToolChoice`（`payload.go:111-154`）：
 * - "none" / {type:"none"} → 删 tool_choice + 删 tools
 * - {type:"auto"/"required"} → 字符串 "auto"/"required"
 * - {type:"function",function:{name:"x"}} → 字符串 "x"
 */
function normalizeToolChoice(body) {
    const tc = body.tool_choice;
    if (tc === undefined)
        return;
    const suppress = () => {
        delete body.tools;
        delete body.functions;
    };
    if (typeof tc === 'string') {
        if (tc.toLowerCase().trim() === 'none') {
            delete body.tool_choice;
            suppress();
        }
        return;
    }
    if (typeof tc === 'object' && tc !== null) {
        const v = tc;
        const typ = typeof v.type === 'string' ? v.type.toLowerCase().trim() : '';
        switch (typ) {
            case 'none':
                delete body.tool_choice;
                suppress();
                break;
            case 'auto':
            case 'required':
                body.tool_choice = typ;
                break;
            case 'function': {
                const fn = v.function;
                let name = typeof fn?.name === 'string' ? fn.name : '';
                if (name.length === 0)
                    name = typeof v.name === 'string' ? v.name : '';
                if (name.trim().length > 0) {
                    body.tool_choice = name.trim();
                }
                else {
                    body.tool_choice = 'auto';
                }
                break;
            }
            default:
                delete body.tool_choice;
        }
        return;
    }
    // 其他类型（非标量）
    delete body.tool_choice;
}
/**
 * tools.parameters 序列化。
 *
 * 对齐 Go 端 `normalizeTools`（`payload.go:160-193`）：
 * SOLO 上游要求 parameters 是 string 类型，OpenAI 标准是 object，
 * 因此须把 parameters 对象序列化为 JSON 字符串。
 */
function normalizeTools(body) {
    const raw = body.tools;
    if (!Array.isArray(raw) || raw.length === 0)
        return;
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const t = item;
        const fn = t.function;
        if (fn === undefined)
            continue;
        const params = fn.parameters;
        if (typeof params === 'object' && params !== null) {
            fn.parameters = JSON.stringify(params);
        }
        out.push(t);
    }
    if (out.length > 0) {
        body.tools = out;
    }
    else {
        delete body.tools;
    }
}
/**
 * 解析一条 SOLO 事件（event 行 + data 行的 JSON）。
 *
 * 对齐 Go 端 `ParseSOLOLine`（`solosse.go:71-106`）与 `scanLine`。
 *
 * @param eventName event 行的值（如 "output" / "token_usage" / "done"）
 * @param dataLine data 行的 JSON 文本
 */
export function parseTraeSSELine(eventName, dataLine) {
    const event = eventName.trim();
    if (dataLine.length === 0)
        return { event };
    let raw;
    try {
        raw = JSON.parse(dataLine);
    }
    catch {
        return { event };
    }
    const ev = { event };
    switch (event) {
        case 'output':
            if (typeof raw.response === 'string')
                ev.response = raw.response;
            if (typeof raw.reasoning_content === 'string')
                ev.reasoningContent = raw.reasoning_content;
            if (raw.tool_calls !== null && raw.tool_calls !== undefined) {
                if (Array.isArray(raw.tool_calls)) {
                    ev.toolCalls = normalizeTraeToolCalls(raw.tool_calls);
                }
            }
            break;
        case 'token_usage':
            ev.usage = raw;
            break;
        case 'done':
            if (typeof raw.finish_reason === 'string')
                ev.finishReason = raw.finish_reason;
            break;
        case 'error':
            if (typeof raw.code === 'number')
                ev.errorCode = raw.code;
            if (typeof raw.message === 'string')
                ev.errorMessage = raw.message;
            break;
    }
    return ev;
}
/**
 * 归一化 SOLO tool_calls 的字段（function_call → function，清理 SOLO 专属字段）。
 *
 * 对齐 Go 端 `mergeToolCallDelta` 的 field normalization 逻辑（`solosse.go:277-279`）。
 */
function normalizeTraeToolCalls(calls) {
    return calls.map((call) => {
        if (typeof call !== 'object' || call === null)
            return call;
        const c = { ...call };
        // function_call → function
        if (typeof c.function_call === 'object' && c.function_call !== null) {
            c.function = { ...c.function_call };
            delete c.function_call;
        }
        // 清理 SOLO 专属字段
        if (typeof c.function === 'object' && c.function !== null) {
            const fn = c.function;
            delete fn.namespace;
            delete fn.partial_arguments;
        }
        return c;
    });
}
/**
 * 生成 OpenAI SSE 格式的 content chunk。
 *
 * 对齐 Go 端 `Stream` / `streamOpts` 的 `writeChunk`（`solosse.go:334-363`）。
 */
export function buildOpenAIChunk(id, delta, finishReason, usage) {
    const chunk = {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        choices: [
            {
                index: 0,
                delta,
            },
        ],
    };
    if (finishReason !== undefined) {
        chunk.choices[0] = {
            ...chunk.choices[0],
            finish_reason: finishReason,
        };
    }
    if (usage !== undefined) {
        chunk.usage = usage;
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
}
/** [DONE] 信号。 */
export const OPENAI_DONE = 'data: [DONE]\n\n';
/**
 * 聚合一个完整的 SOLO SSE 为 OpenAI 格式（非流式场景下一次性解析）。
 *
 * @param lines SOLO SSE 事件的行序列
 */
export function aggregateTraeSSE(lines) {
    const result = {
        content: '',
        reasoningContent: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: undefined,
    };
    let st;
    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        // 空行 = 事件结束
        if (line.length === 0) {
            if (st !== undefined) {
                const ev = parseTraeSSELine(st.event, st.data);
                st = undefined;
                if (ev === undefined)
                    continue;
                switch (ev.event) {
                    case 'output':
                        if (ev.response !== undefined)
                            result.content += ev.response;
                        if (ev.reasoningContent !== undefined)
                            result.reasoningContent += ev.reasoningContent;
                        if (ev.toolCalls !== undefined && ev.toolCalls.length > 0) {
                            result.toolCalls.push(...ev.toolCalls);
                        }
                        break;
                    case 'token_usage':
                        result.usage = ev.usage;
                        break;
                    case 'done':
                        if (ev.finishReason !== undefined)
                            result.finishReason = ev.finishReason;
                        break;
                    case 'error':
                        result.error = { code: ev.errorCode ?? -1, message: ev.errorMessage ?? 'unknown error' };
                        break;
                }
            }
            continue;
        }
        if (line.startsWith('event:')) {
            const newEvent = line.slice(6).trim();
            if (st !== undefined)
                st.event = newEvent;
            else
                st = { event: newEvent, data: '' };
            continue;
        }
        if (line.startsWith('data:')) {
            const data = line.slice(5);
            if (st !== undefined)
                st.data += data;
            continue;
        }
        // 注释行（":"）忽略
    }
    return result;
}
//# sourceMappingURL=trae.js.map