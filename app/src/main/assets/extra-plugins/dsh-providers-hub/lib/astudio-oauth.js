import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
/**
 * AStudio（讯飞 AstronStudio / `cn.xfyun.acode`）—— 登录与会话态展示层。
 *
 * ## 为什么这里没有 OAuth2 / PKCE / 授权 URL / 回调（与 accio-oauth.ts 的关键差异）
 *
 * AStudio 的登录是 **Electron 客户端里的微信扫码**：bundle 内只有
 * `SSOService/wx/scanlogin/{qrcode,uids,bind}`，**不存在任何程序化续期接口**，
 * 授权页与回调都握在客户端自己手里（我们无从走完）。所以与 `accio-oauth.ts`
 * 同型的只有三件事 —— **纯函数 + 终态判定 + 账号掩码展示**。本文件做的是
 * 「导入本机既有会话」与「会话态展示」，**刻意不臆造 loginUrl**（臆造出来的 URL
 * 点了也不会生效，而 UI 会据此以为用户可以自助登录）。
 *
 * ## 三条不能按别的 provider 习惯写的实测结论
 *
 * 1. **磁盘没有任何 TTL / `expiresAt`** ⇒ {@link astudioCredentialExpiresAtMs}
 *    恒返回 `undefined` 是故意的。会话态因此只有两可显示形态：「长期有效」
 *    （服务端 `Set-Cookie: ssoSessionId=…; Max-Age=31536000`，一年且**不滑动**）
 *    与「需人工重新登录」。**绝不渲染到期倒计时**，也不做本地过期预判。
 * 2. **唯一硬终点**：SSO 会话失效时上游恒返回 **HTTP 200 + `code=80000`**
 *    「登录异常，请重新登录」。80000 已在 `ASTUDIO_SESSION_DEAD_CODES` 里，故本层
 *    把它归**终态**、一次性透出人工重登文案，**不循环重试**。
 * 3. **只读客户端文件**：`astron-session.json` 是客户端资产，本层读它、绝不写它；
 *    凭据落库一律走 DSH 凭据库（`astudio-auth.ts`）。
 *
 * ## 展示层的两条纪律
 *
 * - 手机号必须经既有 {@link maskLobsteraiPhoneTail}（只露末 2 位）掩码 —— 本层不
 *   复制第二份掩码算法（两处判据必然漂移；lobsterai 侧因露 4 位被要求整改过）。
 * - 刷新结果 `changed === false` **不是成功**：实测本家不轮换，同 token 撞 401 是
 *   确定性失败，必须与「刷新成功」分格报（见 {@link astudioSessionViewFromRefreshOutcome}）。
 *
 * ## 接线侧约定
 *
 * 接线（`jet-hub-rpc.ts` 的 `account.create`）走 `astudio-auth.ts` 的磁盘导入分支，
 * **不 import 本文件**；本文件只提供展示/掩码与终态判据。`checkAstudioSession` 的
 * `refresh` 形参按注入设计：接线侧传 `ctx.astudioAuth.refreshOnce`，不传就纯读 ——
 * 因此本层在生产路径之外天然零网络（`AstudioAuth extends Service` 的构造需要宿主
 * `ctx`，展示层无权自建服务实例，故这里用最小接口而不是 `new AstudioAuth(...)`）。
 */
import { ASTUDIO } from './astudio-product.js';
import { maskLobsteraiPhoneTail } from './lobsterai.js';
import { astudioCredentialExpiresAtMs, isAstudioSessionDeadError, } from './astudio.js';
import { astudioAccountNickname, astudioSessionFilePath, isAstudioTerminalRefreshError, readAstudioDiskCredential, readAstudioSessionFile, extractAstudioApiKey, AstudioRefreshTokenExpiredError, } from './astudio-auth.js';
/** 凭据库未接线时的默认 ref 名（与 `ASTUDIO.defaultCredentialRef` 同值）。 */
export const ASTUDIO_DEFAULT_CREDENTIAL_REF = 'ASTUDIO_ACCESS_TOKEN';
/** 会话失效（HTTP 200 + code=80000）时唯一允许透出给用户的终态文案。 */
export const ASTUDIO_MANUAL_RELOGIN_HINT = 'AStudio 会话已失效（上游恒为 HTTP 200 + code=80000「登录异常，请重新登录」）。本客户端没有程序化续期接口，请在 AStudio 桌面端重新微信扫码登录后再试；插件侧不会循环重试。';
/** 读不到本机会话时的文案（同样归终态：只能人工登录，无法自动补）。 */
export const ASTUDIO_NO_LOCAL_SESSION_MESSAGE = '未找到本机 AStudio 会话（userdata\\astron-session.json 缺失，或其中没有 modelBearerToken）。请先在 AStudio 客户端登录；如需指向别处的会话文件，设置环境变量 DSH_ASTUDIO_SESSION_FILE。';
/** 有效性副标题：如实说明「长期有效」的依据，并明确不给倒计时。 */
export const ASTUDIO_SESSION_LIFETIME_NOTE = '长期有效：服务端 ssoSessionId 的 Max-Age=31536000（一年且不滑动），磁盘会话文件无 TTL 字段，故不显示到期倒计时。';
function credentialField(credential, key) {
    const raw = credential === undefined || credential === null ? undefined : credential[key];
    return typeof raw === 'string' ? raw.trim() : '';
}
/**
 * 磁盘 `banned` 的形态不固定（`AstudioSessionFile.banned?: boolean | string`），
 * 统一收敛成布尔。读不到会话文件时一律 `false` —— **不臆造**「被封」这种重结论。
 */
export function astudioBannedFromSessionFile(session) {
    const raw = session === undefined || session === null ? undefined : session.banned;
    if (typeof raw === 'boolean')
        return raw;
    if (typeof raw === 'number')
        return raw !== 0;
    if (typeof raw === 'string') {
        const text = raw.trim().toLowerCase();
        return text === 'true' || text === '1';
    }
    return false;
}
/**
 * 任意展示串的手机号掩码。
 *
 * 复用 {@link maskLobsteraiPhoneTail}：只对「像手机号」的输入生效（11 位纯数字且 1 开头，
 * 或 `3 位数字 + 星号 + 数字` 的服务端已脱敏形态），真实昵称原样返回，且幂等。
 * 账号 id / uid 也可能是手机号形态，所以本层对它们同样过一次（已是掩码串的输入不受影响）。
 */
export function maskAstudioAccountLabel(value) {
    const text = (value ?? '').trim();
    if (text.length === 0)
        return '';
    const masked = maskLobsteraiPhoneTail(text);
    return typeof masked === 'string' && masked.trim().length > 0 ? masked.trim() : text;
}
/**
 * 会话态的纯映射：给一份凭据（或 `undefined`）出一行视图，**零网络、零写入**。
 *
 * 展示名走 {@link astudioAccountNickname} → `astudioDisplayNickname` →
 * `maskLobsteraiPhoneTail` 这条**既有**链路（只露末 2 位），本层不再算第二遍。
 */
export function astudioSessionViewFromCredential(credential, options = {}) {
    const fallbackLabel = (options.fallbackLabel ?? '').trim() || 'ASTUDIO';
    const banned = options.banned === true;
    if (credential === undefined || credential === null) {
        return {
            provider: 'astudio',
            state: 'no_local_session',
            account: '',
            accountId: '',
            uid: '',
            loginMethod: '',
            source: '',
            banned: false,
            expiresAtMs: undefined,
            loggedInAt: '',
            statusLine: ASTUDIO_NO_LOCAL_SESSION_MESSAGE,
            hint: ASTUDIO_MANUAL_RELOGIN_HINT,
        };
    }
    const accountId = maskAstudioAccountLabel(credentialField(credential, 'account_id'));
    const uid = maskAstudioAccountLabel(credentialField(credential, 'uid'));
    const account = maskAstudioAccountLabel(astudioAccountNickname(credential, accountId || fallbackLabel) || fallbackLabel);
    // 恒 undefined：保留这次调用是为如实透传「本 provider 不可本地预判到期」这一契约。
    const expiresAtMs = astudioCredentialExpiresAtMs(credential);
    const loginMethod = credentialField(credential, 'login_method');
    const source = credentialField(credential, 'source');
    const loggedInAt = credentialField(credential, 'logged_in_at');
    const state = banned ? 'needs_manual_relogin' : 'active';
    const statusLine = banned
        ? `账号已被客户端标记封禁（磁盘 banned=true），模型调用会持续失败 ⇒ ${ASTUDIO_MANUAL_RELOGIN_HINT}`
        : `已登录：${account}（登录方式=${loginMethod || 'wechat'}，凭据来源=${source || 'session-file'}）—— ${ASTUDIO_SESSION_LIFETIME_NOTE}`;
    return {
        provider: 'astudio',
        state,
        account,
        accountId,
        uid,
        loginMethod,
        source,
        banned,
        expiresAtMs,
        loggedInAt,
        statusLine,
        hint: banned ? ASTUDIO_MANUAL_RELOGIN_HINT : undefined,
    };
}
/**
 * 一次凭据/异常是否属于「只能人工重新登录」的终态（两条判据各覆盖一半）。
 *
 * {@link isAstudioTerminalRefreshError} 按 `error.name === 'RefreshTokenExpiredError'`
 * 判（**不是 instanceof**）并自带文案兜底；{@link isAstudioSessionDeadError} 命中
 * `ASTUDIO_SESSION_DEAD_CODES`（含 80000）。
 * ⚠️ 网络抖动 / 5xx / 未知业务码**都不是**终态 —— 把它们固化成「账号已死」是本仓库
 * 明令禁止的「单向门」事故形态。
 */
export function astudioSessionDeadFromError(error) {
    if (error === undefined || error === null)
        return false;
    if (isAstudioTerminalRefreshError(error))
        return true;
    const record = (typeof error === 'object' ? error : {});
    const rawCode = record.code ?? record.status;
    const code = typeof rawCode === 'number'
        ? rawCode
        : /^-?\d+(\.\d+)?$/.test(String(rawCode ?? '').trim())
            ? Number(String(rawCode).trim())
            : Number.NaN;
    const message = typeof record.message === 'string' ? record.message : String(error);
    if (Number.isFinite(code) && isAstudioSessionDeadError(code, message))
        return true;
    return isAstudioSessionDeadError(0, message);
}
/** 异常 → 会话态视图：终态归 `needs_manual_relogin`，非终态保留原视图不谎报。 */
export function astudioSessionViewFromError(error, fallback) {
    const base = fallback ?? astudioSessionViewFromCredential(undefined);
    if (!astudioSessionDeadFromError(error))
        return base;
    const record = (typeof error === 'object' && error !== null ? error : {});
    const reason = typeof record.message === 'string' ? record.message : String(error);
    return {
        ...base,
        state: 'needs_manual_relogin',
        statusLine: `${ASTUDIO_MANUAL_RELOGIN_HINT}（原始信息：${reason}）`,
        hint: ASTUDIO_MANUAL_RELOGIN_HINT,
    };
}
/**
 * 刷新结果 → 会话态视图（**四态分格**，不压成布尔）。
 *
 * 三格必须分开，混成一格会让 UI 谎报：
 * - `terminal === true` ⇒ 人工重登（含 code=80000 那族）：再多的定时刷新也不会成功；
 * - `fetched !== true` ⇒ 本轮压根没发远端请求（如 Cookie 拼不出）⇒ 属「未刷新」而非失败；
 * - `changed !== true` ⇒ 值没变（实测本家不轮换）⇒ 如实报「重试无意义」，
 *   **绝不能**显示成「刷新成功」；
 * - 其余 ⇒ 凭据真的更新了。
 */
export function astudioSessionViewFromRefreshOutcome(outcome, options = {}) {
    const view = astudioSessionViewFromCredential(outcome.credential, options);
    if (outcome.terminal === true) {
        return {
            ...view,
            state: 'needs_manual_relogin',
            statusLine: `${ASTUDIO_MANUAL_RELOGIN_HINT}（取值判据=${outcome.via}；原因：${outcome.reason || '未提供'}）`,
            hint: ASTUDIO_MANUAL_RELOGIN_HINT,
        };
    }
    if (outcome.fetched !== true) {
        return {
            ...view,
            statusLine: `未发起凭据重取${outcome.reason.length > 0 ? `：${outcome.reason}` : ''}`,
            hint: outcome.reason.length > 0 ? outcome.reason : undefined,
        };
    }
    if (outcome.changed !== true) {
        return {
            ...view,
            statusLine: `凭据重取成功但值未变化（指纹 ${outcome.before} → ${outcome.after}；判据=${outcome.via}）⇒ 本家不轮换，重发同一请求必然同样失败`,
            hint: '这是确定性失败的信号：若此前是 401，请在 AStudio 客户端重新登录。',
        };
    }
    return {
        ...view,
        statusLine: `${view.statusLine}；凭据已更新（指纹 ${outcome.before} → ${outcome.after}；判据=${outcome.via}）`,
    };
}
function sessionFileOf(env) {
    try {
        return astudioSessionFilePath(env);
    }
    catch {
        return '';
    }
}
/**
 * 读会话态：**磁盘快路径优先**，读不到再回落凭据库。
 *
 * 两个数据源都是纯读；上游重取只由 `astudio-auth.ts` 在 HTTP 401 时触发一次，
 * 本层**不越权发起任何网络请求**（所以它也不可能是「登录」的实现）。
 */
export async function readAstudioSessionStatus(options = {}) {
    const refName = (options.refName ?? '').trim() || ASTUDIO_DEFAULT_CREDENTIAL_REF;
    const sessionFile = sessionFileOf(options.env);
    let credential;
    let banned = false;
    try {
        credential = readAstudioDiskCredential(options.env);
        if (credential === undefined) {
            // 磁盘凭据缺失（或客户端重登后写入了 banned）时补读一次原始会话文件。
            banned = astudioBannedFromSessionFile(readAstudioSessionFile(options.env));
            if (options.auth !== undefined && options.auth !== null) {
                credential = await options.auth.currentCredential(refName);
            }
        }
        const view = astudioSessionViewFromCredential(credential, {
            fallbackLabel: options.fallbackLabel,
            banned,
        });
        return {
            ...view,
            sessionFile,
            refName,
            ...(options.includeCredential === true && credential !== undefined ? { credential } : {}),
        };
    }
    catch (error) {
        const view = astudioSessionViewFromError(error, astudioSessionViewFromCredential(undefined, { fallbackLabel: options.fallbackLabel, banned }));
        return { ...view, sessionFile, refName };
    }
}
/**
 * 单步「导入本机既有会话」：把磁盘/库里的既有登录态读成一份视图交接线侧落库。
 *
 * ⚠️ 真正的凭据库写入在 `astudio-auth.ts`（接线缺口 B 的 `importLocalSession`）；
 * 本函数刻意**不写任何东西、不发任何请求** —— 读不到就直接返回
 * `no_local_session` / `needs_manual_relogin` 终态，由 UI 提示人工登录。
 * 之所以是单步而不是 `startLogin` + `pollLogin` 两步：本家没有可展示的本地授权页
 * URL（扫码在客户端窗口里完成），轮询一个不存在的回调只会是死代码。
 */
export async function importAstudioLocalSession(refName, options = {}) {
    return await readAstudioSessionStatus({ ...options, refName, includeCredential: true });
}
/**
 * 「检查登录态 / 需要时重取一次」的展示入口（面板按钮语义）。
 *
 * 只有传入 `refresh`（接线侧 = `ctx.astudioAuth.refreshOnce`）时才可能发远端请求；
 * 不传就退化成纯读 —— 这让单测与无凭据环境下都不会误撞网络。
 */
export async function checkAstudioSession(options = {}) {
    const status = await readAstudioSessionStatus(options);
    if (typeof options.refresh !== 'function')
        return status;
    const refName = (options.refName ?? '').trim() || ASTUDIO_DEFAULT_CREDENTIAL_REF;
    try {
        const outcome = await options.refresh(refName);
        const view = astudioSessionViewFromRefreshOutcome(outcome, { fallbackLabel: options.fallbackLabel });
        return {
            ...view,
            sessionFile: status.sessionFile,
            refName,
            ...(options.includeCredential === true && outcome.credential !== undefined
                ? { credential: outcome.credential }
                : {}),
        };
    }
    catch (error) {
        return astudioSessionViewFromError(error, status);
    }
}
// ── 微信扫码登录与凭据交换 ──
export const ASTUDIO_SSO_BASE_URL = 'https://sso.xfyun.cn';
export const ASTUDIO_SSO_QRCODE_PATH = '/SSOService/wx/scanlogin/qrcode';
export const ASTUDIO_SSO_UIDS_PATH = '/SSOService/wx/scanlogin/uids';
export const ASTUDIO_SSO_BIND_PATH = '/SSOService/wx/scanlogin/bind';
export const ASTUDIO_INIT_APP_PATH = '/tenant-app/v2/init-app';
export const ASTUDIO_USER_INFO_PATH = '/userInfo';
export const ASTUDIO_BOT_CONFIGS_PATH = '/bot/models/configs';
export const ASTUDIO_GEE_CAPTCHA_PATH = '/chat/gee-captcha';
export const ASTUDIO_SEND_SMS_PATH = '/login/mobile/send-verify-code';
export const ASTUDIO_PHONE_LOGIN_PATH = '/login/phone-quick-login';
export const ASTUDIO_PASSWORD_LOGIN_PATH = '/login/check-account';
export const ASTUDIO_CARRIER_PATHS = {
    login: '/astudio/login',
    loginAlt: '/login',
    geeCaptcha: '/astudio/gee-captcha',
    sendSms: '/astudio/sms/send',
    smsLogin: '/astudio/sms/login',
    passwordLogin: '/astudio/password/login',
    wechatQr: '/astudio/wechat/qrcode',
    poll: '/astudio/poll',
};
export const ASTUDIO_WECHAT_FD_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
/** 生成 8 字符的随机 fd 串（官方微信扫码唯一凭证）。 */
export function generateAstudioWechatFd() {
    const bytes = randomBytes(8);
    return Array.from(bytes, (byte) => ASTUDIO_WECHAT_FD_ALPHABET[byte % ASTUDIO_WECHAT_FD_ALPHABET.length]).join('');
}
/**
 * 申请微信扫码登录二维码。
 * 对接 GET https://sso.xfyun.cn/SSOService/wx/scanlogin/qrcode?fd={fd}
 */
export async function createAstudioWechatQrCode(options = {}) {
    const ssoBaseUrl = (options.ssoBaseUrl ?? ASTUDIO_SSO_BASE_URL).replace(/\/+$/, '');
    const fetcher = options.fetcher ?? fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const fd = options.fd ?? generateAstudioWechatFd();
    const url = `${ssoBaseUrl}${ASTUDIO_SSO_QRCODE_PATH}?fd=${encodeURIComponent(fd)}`;
    const response = await fetcher(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new Error(`获取微信扫码二维码失败（HTTP ${response.status}）`);
    }
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        throw new Error('获取微信扫码二维码失败（响应不是 JSON）');
    }
    const record = (typeof body === 'object' && body !== null ? body : {});
    const code = record.code;
    if (code !== 0 && code !== '0') {
        throw new Error(`获取微信扫码二维码失败：${String(record.desc ?? record.message ?? code)}`);
    }
    const qrUrl = typeof record.data === 'string' ? record.data : '';
    if (!qrUrl) {
        throw new Error('获取微信扫码二维码失败：未返回二维码 URL');
    }
    return {
        fd,
        qrUrl,
        expiresInMs: 300_000,
    };
}
/**
 * 轮询微信扫码状态。
 * 对接 GET https://sso.xfyun.cn/SSOService/wx/scanlogin/uids?fd={fd}
 * - code = -1: 未扫码
 * - code = 0: 已扫码，返回关联账号信息
 */
export async function pollAstudioWechatScan(fd, options = {}) {
    const ssoBaseUrl = (options.ssoBaseUrl ?? ASTUDIO_SSO_BASE_URL).replace(/\/+$/, '');
    const fetcher = options.fetcher ?? fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const url = `${ssoBaseUrl}${ASTUDIO_SSO_UIDS_PATH}?fd=${encodeURIComponent(fd)}`;
    let response;
    let text;
    try {
        response = await fetcher(url, {
            method: 'GET',
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
    }
    catch (error) {
        return {
            status: 'error',
            code: -1,
            message: `轮询微信扫码状态网络异常：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (!response.ok) {
        return {
            status: 'error',
            code: response.status,
            message: `轮询微信扫码状态失败（HTTP ${response.status}）`,
        };
    }
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        return {
            status: 'error',
            code: -1,
            message: '轮询微信扫码状态失败（响应不是 JSON）',
        };
    }
    const record = (typeof body === 'object' && body !== null ? body : {});
    // ⚠️ 留痕出口（见 `onRaw` 的说明）：**在解析之前**回调，这样「形状不认识」时也有原始结构。
    try {
        options.onRaw?.(body);
    }
    catch { /* 留痕失败绝不影响登录 */ }
    const rawCode = record.code;
    if (rawCode === -1 || rawCode === '-1') {
        return {
            status: 'pending',
            message: typeof record.desc === 'string' ? record.desc : '未扫码',
        };
    }
    if (rawCode === 0 || rawCode === '0') {
        const accounts = [];
        const data = record.data;
        if (Array.isArray(data)) {
            for (const item of data) {
                if (typeof item === 'object' && item !== null) {
                    const it = item;
                    const uid = String(it.uid ?? it.accountId ?? '').trim();
                    // ⚠️⚠️ **与短信/密码登录同款容错**（2026-10-20 用户报障）：那两条入口是
                    //    `ssoSessionId = data.ssoSessionId ?? data.token`，且 `uid` 与 `ssoSessionId`
                    //    **互为备选**（`ssoSessionId || uid`，见 `loginAstudioWithSms` / `loginAstudioWithPassword`）。
                    //    扫码这里原先**更严**：要求二者都在、且**不认 `token`** ⇒ 上游只下发其一时，
                    //    三入口里**只有扫码会失败**，界面报「已扫码，但上游未下发账号标识」。
                    //    ⚠️ 同一仓库三套口径正是本仓库明令的失效形态 ⇒ 对齐到同款。
                    //    ⚠️ 但仍**不得**产出一项三项全空的账号（兜底后 `ssoSessionId` 必非空，
                    //    半截凭据进号池会让后续每个请求都以 80000 失败）。
                    const ssoSessionId = String(it.ssoSessionId ?? it.sso_session_id ?? it.token ?? uid).trim() || uid;
                    const username = typeof it.username === 'string' ? it.username : undefined;
                    // ⚠️ 判据与 `loginAstudioWithSms` 同款：**至少一个**标识即可（`uid || ssoSessionId`），
                    //    且两者互为兜底 —— 上游在部分路径下只给其中一个。
                    if (uid || ssoSessionId) {
                        accounts.push({ uid: uid || ssoSessionId, ssoSessionId: ssoSessionId || uid, username });
                    }
                }
            }
        }
        else if (typeof data === 'object' && data !== null) {
            const obj = data;
            if (Array.isArray(obj.infoList)) {
                for (const item of obj.infoList) {
                    if (typeof item === 'object' && item !== null) {
                        const it = item;
                        const uid = String(it.uid ?? it.accountId ?? '').trim();
                        // ⚠️⚠️ **与短信/密码登录同款容错**（2026-10-20 用户报障）：那两条入口是
                        //    `ssoSessionId = data.ssoSessionId ?? data.token`，且 `uid` 与 `ssoSessionId`
                        //    **互为备选**（`ssoSessionId || uid`，见 `loginAstudioWithSms` / `loginAstudioWithPassword`）。
                        //    扫码这里原先**更严**：要求二者都在、且**不认 `token`** ⇒ 上游只下发其一时，
                        //    三入口里**只有扫码会失败**，界面报「已扫码，但上游未下发账号标识」。
                        //    ⚠️ 同一仓库三套口径正是本仓库明令的失效形态 ⇒ 对齐到同款。
                        //    ⚠️ 但仍**不得**产出一项三项全空的账号（兜底后 `ssoSessionId` 必非空，
                        //    半截凭据进号池会让后续每个请求都以 80000 失败）。
                        const ssoSessionId = String(it.ssoSessionId ?? it.sso_session_id ?? it.token ?? uid).trim() || uid;
                        const username = typeof it.username === 'string' ? it.username : undefined;
                        if (uid && ssoSessionId) {
                            accounts.push({ uid, ssoSessionId, username });
                        }
                    }
                }
            }
        }
        if (accounts.length === 0) {
            // ⚠️⚠️ **`code === 0` 时 `desc` 是「状态描述」，不是「错误原因」**（2026-10-20 用户报障）：
            //    实测该字段在成功信封里的值就是 `"成功"`（见 `astudio-auth.ts` 的 fact 记录
            //    `{flag:true,code:0,desc:"成功",…}`）⇒ 拿它当失败原因会产出**自相矛盾的文案**：
            //    载体页把 `message` 显示在**红色**状态条里 ⇒ 用户看到红色「成功」，
            //    以为登好了、其实没拿到账号标识（图 1 实测症状）。
            //    ⚠️ 判据必须是**结构化的 `code`**（这里已经在上面的 `rawCode === 0` 分支里），
            //    不能去匹配 `desc` 的文本 —— 那属于本仓库明令的「一改就失效」判据。
            // ⚠️⚠️ 文案必须指向**有效**动作（2026-10-20 探针实测 + 用户确认的真实流程）：
            //    `infoList` 为空 = **该微信号尚未开通 AStudio 账号**。
            //    探针对照证据：已开通的号 `infoList: array(1)`、未开通的号 `array(0)`，
            //    而两次的**信封逐字相同**（`flag=true code=0 desc="成功"`）⇒
            //    `desc` 的「成功」只是**信封状态**（请求成功），与「有没有开通」无关。
            //    ⚠️ 用户的真机流程：**微信扫码第一次需要绑定手机号才能开通**，而那一步
            //    只能在 **AStudio 客户端（IDE）**里做 ⇒ 叫用户「重新扫码」是**假出路**
            //    （同一个号再扫还是空，2026-10-20 用户报障时正是被那句误导）。
            return {
                status: 'unbound',
                message: '该微信号尚未开通 AStudio 账号（上游未返回账号信息）⇒ '
                    + '请先在 AStudio 客户端里用该微信登录并绑定手机号完成开通，再回来扫码',
            };
        }
        return {
            status: 'scanned',
            account: accounts[0],
            accounts,
        };
    }
    return {
        status: 'error',
        code: (typeof rawCode === 'number' || typeof rawCode === 'string') ? rawCode : -1,
        message: typeof record.desc === 'string' ? record.desc : String(rawCode),
    };
}
/**
 * 确认绑定微信登录会话。
 * 对接 POST https://sso.xfyun.cn/SSOService/wx/scanlogin/bind
 */
export async function bindAstudioWechatSession(fd, account, options = {}) {
    const ssoBaseUrl = (options.ssoBaseUrl ?? ASTUDIO_SSO_BASE_URL).replace(/\/+$/, '');
    const fetcher = options.fetcher ?? fetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const params = new URLSearchParams({
        fd,
        accountId: account.uid,
        ...(account.ssoSessionId ? { ssoSessionId: account.ssoSessionId } : {}),
        isNew: 'false',
    });
    const url = `${ssoBaseUrl}${ASTUDIO_SSO_BIND_PATH}`;
    let response;
    let text;
    try {
        response = await fetcher(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: params.toString(),
            signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
    }
    catch (error) {
        return {
            ok: false,
            message: `绑定微信登录会话网络异常：${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (!response.ok) {
        return {
            ok: false,
            message: `绑定微信登录会话失败（HTTP ${response.status}）`,
        };
    }
    try {
        const body = JSON.parse(text);
        if (body.code === 0 || body.code === '0' || body.flag === true) {
            return { ok: true };
        }
        return { ok: false, message: String(body.desc ?? body.message ?? body.code) };
    }
    catch {
        return { ok: true };
    }
}
/**
 * 凭据交换与会话初始化（completeLogin）。
 * 统一支持微信扫码、手机短信快速登录与账号密码登录获取的会话：
 * 1. POST /tenant-app/v2/init-app 会话初始化（非阻塞）；
 * 2. GET /userInfo 获取用户信息与昵称；
 * 3. GET /bot/models/configs 换取模型推理 access_token（modelBearerToken）；
 * 组装并返回完整的 AstudioCredential。
 */
export async function completeAstudioLogin(account, options = {}) {
    const fetcher = options.fetcher ?? fetch;
    const authBaseUrl = (options.authBaseUrl ?? ASTUDIO.authBaseUrl).replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 15_000;
    const rawRecord = (typeof account === 'object' && account !== null ? account : {});
    const uid = String(account.uid ?? rawRecord.uid ?? rawRecord.accountId ?? rawRecord.account_id ?? '').trim();
    const ssoSessionId = String(account.ssoSessionId ?? rawRecord.ssoSessionId ?? rawRecord.sso_session_id ?? '').trim();
    const token = String(rawRecord.token ?? ssoSessionId).trim();
    const accountId = String(rawRecord.accountId ?? rawRecord.account_id ?? uid).trim();
    const loginMethod = String(rawRecord.loginMethod ?? rawRecord.login_method ?? 'wechat').trim();
    const cookie = `ssoSessionId=${ssoSessionId}; sso_sessionid=${ssoSessionId}; account_id=${accountId}; token=${token}`;
    // ① init-app（无条件执行租户开户初始化，使未注册手机号通过短信验证码等方式可自动开户并成功换取凭据）
    try {
        await fetcher(`${authBaseUrl}${ASTUDIO_INIT_APP_PATH}`, {
            method: 'POST',
            headers: { Accept: 'application/json', Cookie: cookie },
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch {
        // 忽略 init-app 非阻塞异常
    }
    // ② userInfo（仅微信登录调用以获取昵称等）
    let nickname = ('nickname' in account && account.nickname) ? account.nickname : account.username;
    if (loginMethod === 'wechat') {
        try {
            const userRes = await fetcher(`${authBaseUrl}${ASTUDIO_USER_INFO_PATH}`, {
                method: 'GET',
                headers: { Accept: 'application/json', Cookie: cookie },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (userRes && userRes.ok) {
                const userBody = await userRes.json();
                const userData = (typeof userBody.data === 'object' && userBody.data !== null ? userBody.data : userBody);
                const candidate = String(userData.nickname ?? userData.mobile ?? userData.username ?? '').trim();
                if (candidate) {
                    nickname = candidate;
                }
            }
        }
        catch {
            // userInfo 降级
        }
    }
    // ③ bot/models/configs 换取模型推理 api_key (modelBearerToken)
    const configsRes = await fetcher(`${authBaseUrl}${ASTUDIO_BOT_CONFIGS_PATH}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Cookie: cookie },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!configsRes.ok) {
        throw new Error(`获取模型配置与推理凭据失败（HTTP ${configsRes.status}）`);
    }
    const configsText = await configsRes.text();
    let configsBody;
    try {
        configsBody = JSON.parse(configsText);
    }
    catch {
        throw new Error('获取模型配置与推理凭据失败（响应不是 JSON）');
    }
    const pick = extractAstudioApiKey(configsBody);
    if (!pick.apiKey) {
        throw new AstudioRefreshTokenExpiredError(`无法从 AStudio 账号后端获取推理凭据：${pick.reason || '无可用 api_key'}`);
    }
    const credential = {
        access_token: pick.apiKey,
        account_id: accountId,
        uid,
        nickname: nickname || ('mobile' in account && account.mobile ? account.mobile : accountId),
        sso_session_id: ssoSessionId,
        token,
        login_method: loginMethod,
        logged_in_at: new Date().toISOString(),
        source: 'account-backend',
    };
    return credential;
}
/**
 * 获取极验初始化配置。
 * 对接 GET https://agent.xfyun.cn/xingchen-studio/chat/gee-captcha
 */
export async function getAstudioGeeTestConfig(options = {}) {
    const fetcher = options.fetcher ?? fetch;
    const authBaseUrl = (options.authBaseUrl ?? ASTUDIO.authBaseUrl).replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 15_000;
    const url = `${authBaseUrl}${ASTUDIO_GEE_CAPTCHA_PATH}?t=${Date.now()}`;
    const res = await fetcher(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        throw new Error(`获取极验验证码配置失败（HTTP ${res.status}）`);
    }
    const body = (await res.json());
    if (body.code !== 0 && body.code !== undefined) {
        const raw = body;
        const msg = String(raw.desc ?? raw.message ?? raw.msg ?? `code=${body.code}`);
        throw new Error(`获取极验验证码配置失败（code=${body.code}）：${msg}`);
    }
    const data = (body.data && typeof body.data === 'object' ? body.data : body);
    if (typeof data.gt !== 'string' || typeof data.challenge !== 'string') {
        throw new Error('极验验证码配置响应缺失 gt 或 challenge 字段');
    }
    return {
        gt: data.gt,
        challenge: data.challenge,
        success: typeof data.success === 'boolean' || typeof data.success === 'number' ? data.success : true,
        new_captcha: Boolean(data.new_captcha),
    };
}
/**
 * 发送短信验证码。
 * 对接 POST https://agent.xfyun.cn/xingchen-studio/login/mobile/send-verify-code
 */
export async function sendAstudioSmsCode(mobile, captcha, options = {}) {
    const normMobile = mobile.trim();
    if (!normMobile) {
        throw new Error('手机号不能为空');
    }
    if (!captcha.geetestChallenge || !captcha.geetestValidate || !captcha.geetestSeccode) {
        throw new Error('缺少极验验证参数（极验验证参数不完整）');
    }
    const fetcher = options.fetcher ?? fetch;
    const authBaseUrl = (options.authBaseUrl ?? ASTUDIO.authBaseUrl).replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 15_000;
    const url = `${authBaseUrl}${ASTUDIO_SEND_SMS_PATH}`;
    const formData = new FormData();
    formData.append('mobile', normMobile);
    formData.append('countryCode', options.countryCode ?? '86');
    formData.append('geetest_challenge', captcha.geetestChallenge);
    formData.append('geetest_validate', captcha.geetestValidate);
    formData.append('geetest_seccode', Buffer.from(captcha.geetestSeccode, 'utf8').toString('base64'));
    const res = await fetcher(url, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        throw new Error(`发送短信验证码请求失败（HTTP ${res.status}）`);
    }
    const body = (await res.json());
    const code = body.code;
    if (code !== 0 && code !== undefined && code !== '0') {
        const msg = String(body.desc ?? body.message ?? body.msg ?? `错误码 ${code}`);
        throw new Error(`发送短信验证码失败：${msg}`);
    }
    return {
        ok: true,
        message: String(body.desc ?? body.message ?? body.msg ?? '短信验证码已发送'),
        data: body.data,
    };
}
/**
 * 手机短信快速登录。
 * 对接 POST https://agent.xfyun.cn/xingchen-studio/login/phone-quick-login
 */
export async function loginAstudioWithSms(mobile, verifyCode, options = {}) {
    const normMobile = mobile.trim();
    const normCode = verifyCode.trim();
    if (!normMobile || !normCode) {
        throw new Error('手机号和验证码不能为空');
    }
    const fetcher = options.fetcher ?? fetch;
    const authBaseUrl = (options.authBaseUrl ?? ASTUDIO.authBaseUrl).replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 15_000;
    const url = `${authBaseUrl}${ASTUDIO_PHONE_LOGIN_PATH}`;
    const formData = new FormData();
    formData.append('mobile', normMobile);
    formData.append('verifyCode', normCode);
    formData.append('countryCode', options.countryCode ?? '86');
    const res = await fetcher(url, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        throw new Error(`手机短信快速登录请求失败（HTTP ${res.status}）`);
    }
    const body = (await res.json());
    const code = body.code;
    if (code !== 0 && code !== undefined && code !== '0') {
        const msg = String(body.desc ?? body.message ?? body.msg ?? `错误码 ${code}`);
        throw new Error(`手机快速登录失败：${msg}`);
    }
    const data = (body.data && typeof body.data === 'object' ? body.data : body);
    const uid = String(data.uid ?? data.account_id ?? '');
    const ssoSessionId = String(data.ssoSessionId ?? data.token ?? '');
    if (!uid && !ssoSessionId) {
        throw new Error('手机登录响应中缺少必要的会话标识（uid 或 ssoSessionId）');
    }
    return {
        uid: uid || ssoSessionId,
        ssoSessionId: ssoSessionId || uid,
        token: data.token ? String(data.token) : (ssoSessionId || uid),
        accountId: data.accountId ? String(data.accountId) : (data.account_id ? String(data.account_id) : (uid || ssoSessionId)),
        mobile: data.mobile ? String(data.mobile) : normMobile,
        loginMethod: 'sms',
    };
}
/**
 * 账号密码登录。
 * 对接 POST https://agent.xfyun.cn/xingchen-studio/login/check-account
 */
export async function loginAstudioWithPassword(accountName, accountPwd, captcha, options = {}) {
    const normName = accountName.trim();
    if (!normName || !accountPwd)
        throw new Error('账号与密码不能为空');
    if (!captcha.geetestChallenge || !captcha.geetestValidate || !captcha.geetestSeccode) {
        throw new Error('缺少极验验证参数（极验验证参数不完整）');
    }
    const fetcher = options.fetcher ?? fetch;
    const authBaseUrl = (options.authBaseUrl ?? ASTUDIO.authBaseUrl).replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 15_000;
    const url = `${authBaseUrl}${ASTUDIO_PASSWORD_LOGIN_PATH}`;
    const formData = new FormData();
    formData.append('accountName', normName);
    formData.append('accountPwd', accountPwd);
    formData.append('geetest_challenge', captcha.geetestChallenge);
    formData.append('geetest_validate', captcha.geetestValidate);
    formData.append('geetest_seccode', Buffer.from(captcha.geetestSeccode, 'utf8').toString('base64'));
    const res = await fetcher(url, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        throw new Error(`密码登录请求失败（HTTP ${res.status}）`);
    }
    const body = (await res.json());
    const code = body.code;
    if (code !== 0 && code !== undefined && code !== '0') {
        const msg = String(body.desc ?? body.message ?? body.msg ?? `错误码 ${code}`);
        throw new Error(`密码登录失败：${msg}`);
    }
    const data = (body.data && typeof body.data === 'object' ? body.data : body);
    const uid = String(data.uid ?? data.account_id ?? '');
    const ssoSessionId = String(data.ssoSessionId ?? data.token ?? '');
    if (!uid && !ssoSessionId) {
        throw new Error('密码登录响应中缺少必要的会话标识（uid 或 ssoSessionId）');
    }
    return {
        uid: uid || ssoSessionId,
        ssoSessionId: ssoSessionId || uid,
        token: data.token ? String(data.token) : (ssoSessionId || uid),
        accountId: data.accountId ? String(data.accountId) : (data.account_id ? String(data.account_id) : (uid || ssoSessionId)),
        nickname: data.nickname ? String(data.nickname) : undefined,
        mobile: data.mobile ? String(data.mobile) : undefined,
        username: normName,
        loginMethod: 'password',
    };
}
/**
 * 渲染 AStudio Carrier Server 载体页 HTML（含手机验证码、账号密码、微信扫码 3 个 Tab）。
 */
export function renderAstudioLoginPage(options = {}) {
    const initialQr = options.initialWechatQrUrl ?? '';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AStudio 登录</title>
<script src="https://static.geetest.com/static/tools/gt.js"></script>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: #f4f5f8; color: #1d2129;
  }
  .card {
    background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.06);
    width: 360px; max-width: 90vw; text-align: center;
  }
  h1 { font-size: 18px; margin: 0 0 16px; font-weight: 600; color: #1d2129; }
  .tabs {
    display: flex; gap: 4px; background: #f2f3f5; border-radius: 8px; padding: 4px; margin-bottom: 20px;
  }
  .tab-btn {
    flex: 1; padding: 8px 4px; font-size: 13px; border: 0; border-radius: 6px;
    background: transparent; color: #4e5969; cursor: pointer; transition: all 0.2s;
  }
  .tab-btn.active {
    background: #fff; color: #165dff; font-weight: 600; box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }
  .pane { display: none; text-align: left; }
  .pane.active { display: block; }
  .login-guide-tip { font-size: 12px; color: #86909c; text-align: center; margin-top: 10px; line-height: 1.4; }
  .form-group { margin-bottom: 14px; }
  label { display: block; font-size: 12px; color: #4e5969; margin-bottom: 6px; }
  input {
    width: 100%; height: 38px; padding: 0 12px; font-size: 14px; border: 1px solid #d9dde3;
    border-radius: 6px; outline: none; transition: border-color 0.2s;
  }
  input:focus { border-color: #165dff; }
  .btn-primary {
    width: 100%; height: 38px; font-size: 14px; font-weight: 500; border: 0; border-radius: 6px;
    background: #165dff; color: #fff; cursor: pointer; transition: background 0.2s; margin-top: 8px;
  }
  .btn-primary:hover { background: #0e42d2; }
  .btn-primary:disabled { background: #c9cdd4; cursor: not-allowed; }
  .row-input { display: flex; gap: 8px; }
  .row-input input { flex: 1; }
  .btn-secondary {
    white-space: nowrap; padding: 0 12px; height: 38px; font-size: 13px; border: 1px solid #c9cdd4;
    border-radius: 6px; background: #f2f3f5; color: #4e5969; cursor: pointer;
  }
  .btn-secondary:disabled { color: #86909c; cursor: not-allowed; }
  .captcha-box {
    min-height: 40px; margin-bottom: 12px; display: flex; align-items: center; justify-content: center;
    background: #f7f8fa; border: 1px dashed #c9cdd4; border-radius: 6px; font-size: 12px; color: #86909c;
    padding: 6px 10px;
  }
  .captcha-ready { border-color: #00b42a; background: #e8ffea; color: #00b42a; font-weight: 500; }
  .qr-box {
    width: 200px; height: 200px; margin: 10px auto; border: 1px solid #e5e6eb; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; overflow: hidden; background: #fafafa;
  }
  .qr-box img { width: 100%; height: 100%; object-fit: contain; }
  .wechat-tip { font-size: 12px; color: #86909c; text-align: center; margin: 8px 0 0; }
  .status-bar {
    margin-top: 14px; min-height: 20px; font-size: 13px; text-align: center; border-radius: 4px; padding: 4px;
  }
  .status-bar.ok { color: #00b42a; background: #e8ffea; font-weight: 500; }
  .status-bar.err { color: #f53f3f; background: #ffece8; }
</style>
</head>
<body>
  <div class="card">
    <h1>登录 AStudio</h1>

    <div class="tabs">
      <button class="tab-btn tab-sms active" id="tabSms" data-tab="sms" type="button">手机验证码</button>
      <button class="tab-btn tab-password" id="tabPassword" data-tab="password" type="button">账号密码</button>
      <button class="tab-btn tab-wechat" id="tabWechat" data-tab="wechat" type="button">微信扫码</button>
    </div>

    <!-- Tab 1: 手机验证码 -->
    <div class="pane active" id="pane-sms">
      <div class="form-group">
        <label for="smsMobile">手机号</label>
        <input id="smsMobile" class="sms-mobile" type="tel" placeholder="请输入中国大陆手机号" maxlength="11" />
      </div>
      <div class="form-group">
        <label>人机验证</label>
        <div class="captcha-box" id="smsCaptchaBox">
          <button class="btn-secondary" id="btnTriggerSmsCaptcha" type="button">完成安全验证</button>
        </div>
      </div>
      <div class="form-group">
        <label for="smsCode">验证码</label>
        <div class="row-input">
          <input id="smsCode" class="sms-code" type="text" placeholder="6 位验证码" maxlength="6" />
          <button class="btn-secondary" id="btnSendSms" type="button">获取验证码</button>
        </div>
      </div>
      <button class="btn-primary" id="btnLoginSms" type="button">登 录</button>
      <div class="login-guide-tip">未注册手机号验证通过后将自动完成注册开户</div>
    </div>

    <!-- Tab 2: 账号密码 -->
    <div class="pane" id="pane-password">
      <div class="form-group">
        <label for="pwdAccount">账号 / 手机号</label>
        <input id="pwdAccount" class="pwd-account" type="text" placeholder="请输入账号或手机号" />
      </div>
      <div class="form-group">
        <label for="pwdPassword">密码</label>
        <input id="pwdPassword" class="pwd-password" type="password" placeholder="请输入登录密码" />
      </div>
      <div class="form-group">
        <label>人机验证</label>
        <div class="captcha-box" id="pwdCaptchaBox">
          <button class="btn-secondary" id="btnTriggerPwdCaptcha" type="button">完成安全验证</button>
        </div>
      </div>
      <button class="btn-primary" id="btnLoginPwd" type="button">登 录</button>
      <div class="login-guide-tip">未注册账号请使用手机验证码快捷登录开户</div>
    </div>

    <!-- Tab 3: 微信扫码 -->
    <div class="pane" id="pane-wechat">
      <div class="qr-box" id="wechatQrContainer">
        ${initialQr ? `<img src="${initialQr}" alt="微信登录二维码" />` : '<span>正在加载二维码...</span>'}
      </div>
      <p class="wechat-tip">请打开微信扫描上方二维码进行登录</p>
      <div style="text-align: center; margin-top: 8px;">
        <button class="btn-secondary" id="btnRefreshQr" type="button" style="font-size: 12px; height: 30px;">刷新二维码</button>
      </div>
    </div>

    <div class="status-bar" id="statusBar"></div>
  </div>

  <script>
    (function() {
      var currentTab = 'sms';
      var smsCaptchaResult = null;
      var pwdCaptchaResult = null;
      var pollTimer = null;
      var currentFd = '';

      var statusBar = document.getElementById('statusBar');
      function showStatus(msg, type) {
        statusBar.textContent = msg;
        statusBar.className = 'status-bar ' + (type || '');
      }

      // Tab 切换
      var tabBtns = document.querySelectorAll('.tab-btn');
      var panes = document.querySelectorAll('.pane');
      tabBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          var target = btn.getAttribute('data-tab');
          currentTab = target;
          tabBtns.forEach(function(b) { b.classList.remove('active'); });
          panes.forEach(function(p) { p.classList.remove('active'); });
          btn.classList.add('active');
          document.getElementById('pane-' + target).classList.add('active');
          showStatus('', '');

          if (target === 'wechat') {
            loadWechatQr();
          } else {
            stopWechatPoll();
          }
        });
      });

      // 动态载入官方 gt.js SDK
      var gtScriptPromise = null;
      function ensureGeetestSdk() {
        if (typeof window.initGeetest === 'function') {
          return Promise.resolve();
        }
        if (gtScriptPromise) {
          return gtScriptPromise;
        }
        gtScriptPromise = new Promise(function(resolve, reject) {
          var script = document.createElement('script');
          script.src = 'https://static.geetest.com/static/tools/gt.js';
          script.async = true;
          script.dataset.astronGeetest = 'true';
          script.addEventListener('load', function() { resolve(); }, { once: true });
          script.addEventListener('error', function() {
            script.remove();
            gtScriptPromise = null;
            reject(new Error('安全验证组件加载失败，请检查网络后重试。'));
          }, { once: true });
          document.head.appendChild(script);
        });
        return gtScriptPromise;
      }

      // 拉起极验滑块弹窗并捕获 validate / seccode 回调
      async function triggerGeetestCaptcha() {
        await ensureGeetestSdk();
        if (typeof window.initGeetest !== 'function') {
          throw new Error('安全验证组件不可用，请稍后重试。');
        }
        var res = await fetch('/astudio/gee-captcha');
        var json = await res.json();
        if (!json.ok || !json.data) throw new Error(json.message || '获取验证码配置失败');
        var config = json.data;

        return new Promise(function(resolve, reject) {
          var finished = false;
          var captchaInstance = null;
          function finish(result) {
            if (!finished) {
              finished = true;
              window.clearTimeout(timer);
              try {
                if (captchaInstance && typeof captchaInstance.destroy === 'function') {
                  captchaInstance.destroy();
                }
              } catch (_) {}
              if ('payload' in result) {
                resolve(result.payload);
              } else {
                reject(result.error);
              }
            }
          }
          var timer = window.setTimeout(function() {
            finish({ error: new Error('安全验证超时，请重试。') });
          }, 30000);

          try {
            window.initGeetest(Object.assign({}, config, {
              https: true,
              offline: !config.success,
              product: 'bind',
              width: '100%'
            }), function(captchaObj) {
              captchaInstance = captchaObj;
              captchaObj.onReady(function() {
                try {
                  captchaObj.verify();
                } catch (verifyErr) {
                  finish({ error: new Error('安全验证启动失败，请重试。') });
                }
              });
              captchaObj.onError(function() {
                finish({ error: new Error('安全验证网络异常，请稍后重试。') });
              });
              if (typeof captchaObj.onClose === 'function') {
                captchaObj.onClose(function() {
                  finish({ error: new Error('安全验证已取消。') });
                });
              }
              captchaObj.onSuccess(function() {
                var val = captchaObj.getValidate();
                if (!val || !val.geetest_challenge || !val.geetest_validate || !val.geetest_seccode) {
                  finish({ error: new Error('安全验证结果无效，请重试。') });
                  return;
                }
                finish({
                  payload: {
                    geetestChallenge: val.geetest_challenge,
                    geetestValidate: val.geetest_validate,
                    geetestSeccode: val.geetest_seccode
                  }
                });
              });
            });
          } catch (initErr) {
            finish({ error: initErr instanceof Error ? initErr : new Error(String(initErr)) });
          }
        });
      }

      // 极验人机验证触发绑定
      function setupCaptcha(triggerBtn, boxElem, onVerified) {
        triggerBtn.addEventListener('click', async function() {
          triggerBtn.disabled = true;
          triggerBtn.textContent = '正在拉起验证...';
          try {
            var captcha = await triggerGeetestCaptcha();
            onVerified(captcha);
            boxElem.innerHTML = '<span class="captcha-ready">✓ 已完成安全验证</span>';
          } catch (e) {
            triggerBtn.disabled = false;
            triggerBtn.textContent = '验证失败，重试';
            showStatus(e.message || '安全验证失败', 'err');
          }
        });
      }

      setupCaptcha(document.getElementById('btnTriggerSmsCaptcha'), document.getElementById('smsCaptchaBox'), function(res) {
        smsCaptchaResult = res;
      });
      setupCaptcha(document.getElementById('btnTriggerPwdCaptcha'), document.getElementById('pwdCaptchaBox'), function(res) {
        pwdCaptchaResult = res;
      });

      // 发送短信验证码
      var btnSendSms = document.getElementById('btnSendSms');
      btnSendSms.addEventListener('click', async function() {
        var mobile = document.getElementById('smsMobile').value.trim();
        if (!mobile) return showStatus('请输入手机号', 'err');
        if (!smsCaptchaResult) return showStatus('请先完成人机安全验证', 'err');

        btnSendSms.disabled = true;
        showStatus('正在发送验证码...', '');
        try {
          var res = await fetch('/astudio/sms/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mobile: mobile,
              geetestChallenge: smsCaptchaResult.geetestChallenge,
              geetestValidate: smsCaptchaResult.geetestValidate,
              geetestSeccode: smsCaptchaResult.geetestSeccode
            })
          });
          var data = await res.json();
          if (!data.ok) throw new Error(data.message || '发送失败');
          showStatus(data.message || '验证码已发送', 'ok');
          var sec = 60;
          var t = setInterval(function() {
            sec--;
            if (sec <= 0) {
              clearInterval(t);
              btnSendSms.disabled = false;
              btnSendSms.textContent = '获取验证码';
            } else {
              btnSendSms.textContent = sec + 's';
            }
          }, 1000);
        } catch (e) {
          btnSendSms.disabled = false;
          showStatus(e.message, 'err');
        }
      });

      // 手机号登录
      document.getElementById('btnLoginSms').addEventListener('click', async function() {
        var mobile = document.getElementById('smsMobile').value.trim();
        var code = document.getElementById('smsCode').value.trim();
        if (!mobile) return showStatus('请输入手机号', 'err');
        if (!code) return showStatus('请输入短信验证码', 'err');

        showStatus('正在登录...', '');
        try {
          var res = await fetch('/astudio/sms/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mobile: mobile, verifyCode: code })
          });
          var data = await res.json();
          if (!data.ok) throw new Error(data.message || '登录失败');
          showStatus('登录成功！凭据已同步，请返回 IDE', 'ok');
        } catch (e) {
          showStatus(e.message, 'err');
        }
      });

      // 密码登录
      document.getElementById('btnLoginPwd').addEventListener('click', async function() {
        var account = document.getElementById('pwdAccount').value.trim();
        var pwd = document.getElementById('pwdPassword').value;
        if (!account) return showStatus('请输入账号或手机号', 'err');
        if (!pwd) return showStatus('请输入密码', 'err');
        if (!pwdCaptchaResult) return showStatus('请先完成人机安全验证', 'err');

        showStatus('正在登录...', '');
        try {
          var res = await fetch('/astudio/password/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accountName: account,
              accountPwd: pwd,
              geetestChallenge: pwdCaptchaResult.geetestChallenge,
              geetestValidate: pwdCaptchaResult.geetestValidate,
              geetestSeccode: pwdCaptchaResult.geetestSeccode
            })
          });
          var data = await res.json();
          if (!data.ok) throw new Error(data.message || '登录失败');
          showStatus('登录成功！凭据已同步，请返回 IDE', 'ok');
        } catch (e) {
          showStatus(e.message, 'err');
        }
      });

      // 微信扫码
      async function loadWechatQr() {
        stopWechatPoll();
        var box = document.getElementById('wechatQrContainer');
        box.innerHTML = '<span>正在加载二维码...</span>';
        try {
          var res = await fetch('/astudio/wechat/qrcode');
          var data = await res.json();
          if (!data.ok || !data.qrUrl) throw new Error(data.message || '获取二维码失败');
          currentFd = data.fd;
          box.innerHTML = '<img src="' + data.qrUrl + '" alt="微信二维码" />';
          startWechatPoll();
        } catch (e) {
          box.innerHTML = '<span style="color:#f53f3f;font-size:12px;">加载失败，请点击刷新</span>';
          showStatus(e.message, 'err');
        }
      }

      function startWechatPoll() {
        stopWechatPoll();
        pollTimer = setInterval(async function() {
          try {
            var res = await fetch('/astudio/poll');
            var data = await res.json();
            if (data.status === 'success') {
              stopWechatPoll();
              showStatus('微信扫码登录成功！凭据已同步，请返回 IDE', 'ok');
            } else if (data.status === 'error' || data.status === 'unbound') {
              stopWechatPoll();
              showStatus(data.message || '微信扫码登录失效，请刷新重试', 'err');
            }
          } catch (e) {}
        }, 2000);
      }

      function stopWechatPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }

      document.getElementById('btnRefreshQr').addEventListener('click', loadWechatQr);
    })();
  </script>
</body>
</html>`;
}
async function readJsonBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buf = chunk;
        total += buf.length;
        if (total > 64 * 1024)
            throw new Error('请求体过大');
        chunks.push(buf);
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    if (text.length === 0)
        return {};
    try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        throw new Error('请求体不是合法 JSON');
    }
}
function writeJsonResponse(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(JSON.stringify(data));
}
function listenOnRandomPort(server) {
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (typeof addr === 'object' && addr !== null) {
                resolve(addr.port);
            }
            else {
                reject(new Error('无法获取 AStudio carrier server 监听端口'));
            }
        });
        server.on('error', reject);
    });
}
/**
 * 启动 AStudio Carrier Server 本地载体页服务。
 */
export async function startAstudioLoginFlow(options = {}) {
    const product = options.product ?? ASTUDIO;
    const fetcher = options.fetcher ?? fetch;
    const authBaseUrl = (options.authBaseUrl ?? product.authBaseUrl).replace(/\/+$/, '');
    const ssoBaseUrl = (options.ssoBaseUrl ?? ASTUDIO_SSO_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 300_000;
    const state = {};
    let settleOk;
    let settleFail;
    const resultPromise = new Promise((resolve, reject) => {
        settleOk = resolve;
        settleFail = reject;
    });
    let server;
    let closed = false;
    const closeServer = async () => {
        if (closed)
            return;
        closed = true;
        if (server) {
            await new Promise((resolve) => {
                server?.close(() => resolve());
            });
            server = undefined;
        }
    };
    const timer = setTimeout(() => {
        settleFail(new Error('AStudio 登录超时（超过 5 分钟无操作）'));
        void closeServer();
    }, timeoutMs);
    const finalResult = resultPromise.finally(() => {
        clearTimeout(timer);
    });
    server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', `http://127.0.0.1:${req.socket.localPort ?? 0}`);
            const pathname = url.pathname;
            if (pathname === ASTUDIO_CARRIER_PATHS.login || pathname === ASTUDIO_CARRIER_PATHS.loginAlt) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderAstudioLoginPage({ product }));
                return;
            }
            if (pathname === ASTUDIO_CARRIER_PATHS.geeCaptcha) {
                try {
                    const config = await getAstudioGeeTestConfig({ fetcher, authBaseUrl });
                    writeJsonResponse(res, 200, { ok: true, data: config });
                }
                catch (error) {
                    writeJsonResponse(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (pathname === ASTUDIO_CARRIER_PATHS.sendSms) {
                if (req.method !== 'POST') {
                    writeJsonResponse(res, 405, { ok: false, message: 'Method Not Allowed' });
                    return;
                }
                try {
                    const body = await readJsonBody(req);
                    const mobile = String(body.mobile ?? '');
                    const captcha = {
                        geetestChallenge: String(body.geetestChallenge ?? ''),
                        geetestValidate: String(body.geetestValidate ?? ''),
                        geetestSeccode: String(body.geetestSeccode ?? ''),
                    };
                    const sendRes = await sendAstudioSmsCode(mobile, captcha, {
                        countryCode: body.countryCode ? String(body.countryCode) : '86',
                        fetcher,
                        authBaseUrl,
                    });
                    writeJsonResponse(res, 200, sendRes);
                }
                catch (error) {
                    writeJsonResponse(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (pathname === ASTUDIO_CARRIER_PATHS.smsLogin) {
                if (req.method !== 'POST') {
                    writeJsonResponse(res, 405, { ok: false, message: 'Method Not Allowed' });
                    return;
                }
                try {
                    const body = await readJsonBody(req);
                    const mobile = String(body.mobile ?? '');
                    const verifyCode = String(body.verifyCode ?? '');
                    const identity = await loginAstudioWithSms(mobile, verifyCode, {
                        countryCode: body.countryCode ? String(body.countryCode) : '86',
                        fetcher,
                        authBaseUrl,
                    });
                    const credential = await completeAstudioLogin(identity, { fetcher, authBaseUrl });
                    writeJsonResponse(res, 200, { ok: true, message: '登录成功' });
                    settleOk(credential);
                    void options.onSuccess?.(credential);
                    setTimeout(() => void closeServer(), 500);
                }
                catch (error) {
                    writeJsonResponse(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (pathname === ASTUDIO_CARRIER_PATHS.passwordLogin) {
                if (req.method !== 'POST') {
                    writeJsonResponse(res, 405, { ok: false, message: 'Method Not Allowed' });
                    return;
                }
                try {
                    const body = await readJsonBody(req);
                    const accountName = String(body.accountName ?? '');
                    const accountPwd = String(body.accountPwd ?? '');
                    const captcha = {
                        geetestChallenge: String(body.geetestChallenge ?? ''),
                        geetestValidate: String(body.geetestValidate ?? ''),
                        geetestSeccode: String(body.geetestSeccode ?? ''),
                    };
                    const identity = await loginAstudioWithPassword(accountName, accountPwd, captcha, {
                        fetcher,
                        authBaseUrl,
                    });
                    const credential = await completeAstudioLogin(identity, { fetcher, authBaseUrl });
                    writeJsonResponse(res, 200, { ok: true, message: '登录成功' });
                    settleOk(credential);
                    void options.onSuccess?.(credential);
                    setTimeout(() => void closeServer(), 500);
                }
                catch (error) {
                    writeJsonResponse(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (pathname === ASTUDIO_CARRIER_PATHS.wechatQr) {
                try {
                    const qr = await createAstudioWechatQrCode({ fetcher, ssoBaseUrl });
                    state.wechatFd = qr.fd;
                    writeJsonResponse(res, 200, { ok: true, qrUrl: qr.qrUrl, fd: qr.fd });
                }
                catch (error) {
                    writeJsonResponse(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            if (pathname === ASTUDIO_CARRIER_PATHS.poll) {
                if (!state.wechatFd) {
                    writeJsonResponse(res, 200, { status: 'pending', message: '未获取二维码' });
                    return;
                }
                try {
                    const scanRes = await pollAstudioWechatScan(state.wechatFd, { fetcher, ssoBaseUrl });
                    if (scanRes.status === 'scanned') {
                        await bindAstudioWechatSession(state.wechatFd, scanRes.account, { fetcher, ssoBaseUrl }).catch(() => { });
                        const credential = await completeAstudioLogin(scanRes.account, { fetcher, authBaseUrl });
                        writeJsonResponse(res, 200, { status: 'success', message: '登录成功' });
                        settleOk(credential);
                        void options.onSuccess?.(credential);
                        setTimeout(() => void closeServer(), 500);
                        return;
                    }
                    writeJsonResponse(res, 200, scanRes);
                }
                catch (error) {
                    writeJsonResponse(res, 500, { status: 'error', message: error instanceof Error ? error.message : String(error) });
                }
                return;
            }
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
        }
        catch (error) {
            writeJsonResponse(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
        }
    });
    const port = await listenOnRandomPort(server);
    const loginUrl = `http://127.0.0.1:${port}${ASTUDIO_CARRIER_PATHS.login}`;
    return {
        loginUrl,
        result: finalResult,
        close: closeServer,
    };
}
//# sourceMappingURL=astudio-oauth.js.map