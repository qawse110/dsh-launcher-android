/**
 * OfficeAce 凭据层：DSH 自主华为云 OAuth（PKCE + DPoP），**零外部依赖**。
 *
 * ## 为什么不用 OfficeAce 客户端
 *
 * 早期实现从 OfficeAce 的本机 Redis 读凭据 —— 但那要求用户装过并登录过客户端。
 * 逆向（2026-10-12，全部实测验证）发现华为云的登录链**完全公开可自走**：
 *
 * ```
 * 1. POST {claw}/v1/claw/auth/state          → 云侧登记 state（匿名）
 * 2. 浏览器打开 auth.huaweicloud.com 授权页    → SSO 秒过 → 回调带 code
 * 3. GET  {claw}/v1/claw/auth/code?state=    → 取回 code（匿名，秒级时效）
 * 4. POST sts.../v1/oauth2/tokens            → code+verifier+DPoP 换 token
 * 5. GET  {claw}/v1/claw/client-permission-validate（AK/SK 签名）
 *    → 返回 modelInfo（model_app_key/secret）⇒ 推理凭据
 * ```
 *
 * client_id `pdp5_for_agentarts` 是 PKCE 公开客户端（无 secret），redirect_uri
 * 是云侧固定域 —— DSH 复用同一组参数，无需任何注册。
 *
 * ## 凭据存储（DSH 自有，JSON 文件）
 *
 * `~/.dsh-officeace/session.json`：token + refresh_token + modelInfo + DPoP 私钥
 * （DPoP 私钥**必须持久化**：refresh 请求要用同一把密钥签 DPoP）。
 *
 * ## 时序陷阱（实测踩过）
 *
 * - code 有效期**秒级**：拿到后必须立刻换 token（一体化流程，不能分两步交互）
 * - state 必须来自云侧（自造的查不到）
 * - refresh_token 一次性：刷新成功后必须立即落盘新 token，否则重放触发
 *   STS5.1806 "has been used" 死循环（OfficeAce 源码注释里的同款教训）
 */
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { OFFICEACE } from './officeace-product.js';
import { SerialQueue } from './serial-queue.js';
import { shouldRefreshNow } from './expiry-sync.js';
import { markLoginNeedsExternalAction } from './login-failure.js';
/** 华为云端点（与 OfficeAce green-package 的默认值一致）。 */
const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';
const TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
const CLIENT_ID = 'pdp5_for_agentarts';
const REDIRECT_URI = `${CLAW_BASE}/v1/claw/auth/callback`;
/**
 * 本模块所有**用户级**路径的根（凭据 + OfficeAce 客户端遗留物）。
 *
 * ⚠️⚠️ **`DSH_OFFICEACE_HOME` 覆盖优先**（2026-10-14 IKLPTZ 修复时补，**安全关键**）。
 *
 * 本目录下的 `session.json` 是**用户真实的华为云凭据**，而 OfficeAce 的
 * `refresh_token` **一次性**（见模块头的 STS5.1806 教训）—— 单测若顺着
 * 「空池兜底」分支读进来并发一次续期，就会**消费掉用户的一次性 token**，
 * 用户被迫重新登录。
 *
 * 这条路径**真实可达**（实测踩到）：`src/index.ts` 的 `apply()` 里有
 * `void refreshAllCredentials()` 的 fire-and-forget 首轮，`afterEach` 把
 * `USERPROFILE` 恢复成真实 home **之后**，那条后台链才跑到本模块的兜底分支，
 * 于是用真实目录读凭据、真发 STS 请求（vitest 输出里出现真实报文
 * `STS5.1806 has been used`）。用例自身改 `USERPROFILE` **来不及** ——
 * 竞态在用例结束之后才发生。
 *
 * ⇒ 与 `jet-hub-store.ts` 的 `DSH_JET_HUB_STATE_DIR` **同型**：单测在
 * `tests/setup-isolation.ts` 里把它指向临时目录，从进程级根除该路径。
 * `USERPROFILE` / `HOME` 改写仍是第二道防线（对 `os.homedir()` 生效）。
 *
 * ## ⚠️ 为什么不叫 `storeDir()` 了（2026-10-14 对抗性审计）
 *
 * 它现在同时是**另外两处** `os.homedir()` 的根（下节 `officeAceClientHome()`），
 * 故名字必须如实反映「这是 home 根，不只是凭据目录」—— 否则下一个读代码的人
 * 会以为「隔离只覆盖凭据」，从而漏掉 `.office-claw` 那两条腿。
 */
function officeaceHome() {
    const override = process.env.DSH_OFFICEACE_HOME;
    if (override !== undefined && override.trim().length > 0)
        return override.trim();
    return path.join(os.homedir(), '.dsh-officeace');
}
/**
 * OfficeAce **桌面客户端**遗留物的根（`.office-claw`）。
 *
 * ⚠️⚠️ **2026-10-14 对抗性审计打穿后补**：本模块原先有**两处**直接
 * `os.homedir()` 拼 `~/.office-claw/...`，**不在** `DSH_OFFICEACE_HOME`
 * 的覆盖范围内：
 *
 * - {@link readSessionCookie} 读 `~/.office-claw/session.cookie`
 *   （审计实测：**真实存在**、DPAPI 解密成功）；
 * - `fetchSubscriptionSummary` 的本地腿读 `~/.office-claw/certs/root-ca.pem`。
 *
 * 审计同时**实测判定「当前不可达」**：全量 8071 条单测跑完，
 * `readSessionCookie` 的调用栈只有审计者自己的临时探针，**零生产 spec 触达**
 * （所有调用点都传了 `ref` ⇒ 走云侧直读，不落本地腿）。
 *
 * ⚠️ 但那是**脆弱的绿**：任何新测试调 `readSessionCookie()` /
 * `fetchModelTokenRates()`，或 `fetchSubscriptionSummary(48)` 不带 ref 的
 * 老路径被重新启用，就会立刻读到用户真实文件。读 cookie **不会**烧 token
 * （危害远小于 `session.json`），故属加固而非紧急修复。
 *
 * ⇒ 与 {@link officeaceHome} 用**同一个** env 覆盖：隔离要么全覆盖，要么
 * 留一条谁也不知道的缝。
 */
function officeAceClientHome() {
    const override = process.env.DSH_OFFICEACE_HOME;
    if (override !== undefined && override.trim().length > 0) {
        return path.join(override.trim(), '.office-claw');
    }
    return path.join(os.homedir(), '.office-claw');
}
function storeFile() {
    return path.join(officeaceHome(), 'session.json');
}
// ────────────────────────── 存储 ──────────────────────────
//
// ⚠️ **按 credentialRef 分文件**（2026-10-13 改造）：原先所有卡片共用
//    `session.json` 一个文件 ⇒ 第二次登录覆盖第一次的凭据，多账号无法共存。
//    现在每个账号一份 `session-<ref>.json`，与其余渠道「每卡片一份独立凭据」
//    的形状对齐 —— 号池轮换/多账号才真正可用。
//
//    ⚠️ 兼容：无 ref 时仍落 `session.json`（老数据、以及不传 ref 的调用点），
//    `readStoredCredential()` 的默认读取路径不变。
/** 凭据 ref → 文件名（只保留安全字符，避免 ref 里的特殊字符污染路径）。 */
function storeFileFor(ref) {
    if (ref === undefined || ref.length === 0)
        return storeFile();
    const safe = ref.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(officeaceHome(), `session-${safe}.json`);
}
/**
 * 凭据是否**足以发起云侧签名请求**（`access` + `securityToken` 都在且非空）。
 *
 * ⚠️⚠️ **必须用可选链判「缺失」，不能只判「空串」**（2026-10-18 审计实测的 P0）。
 *
 * 修前是三处一模一样的 `credential.access.length === 0`（`fetchModelTokenRates`
 * / `fetchCloudSubscriptionFor` / `claimDailyBonus`），而 `readStoredCredential`
 * **只校验 `modelAppKey`** ⇒ 一份 `access` 字段**缺失**（`undefined`）的凭据
 * 能一路读到这里，于是 `.length` 在 `try` 之外抛
 * `TypeError: Cannot read properties of undefined (reading 'length')`：
 *
 * - 在 `claimDailyBonus` 里它 escape 出函数 ⇒ 调用方拿到的不是 `{ok:false}`
 *   而是 reject ⇒ 异常被 L1206/L1271 的空 `catch` 静默吞掉 ⇒
 *   **既没有留痕、余额查询也一并被跳过**（面板该次刷新零网络请求）；
 * - 那正是本 PR 要消灭的「静默 + 阻断」形态，在另一条支路上被原样复现。
 *
 * ⚠️ 同义判据只留**这一份**：三处各自写一遍必然漂移（本仓库明列的坑），
 *   新增第四处时也必须走它。
 */
function credentialUsable(credential) {
    return (credential !== undefined
        && typeof credential.access === 'string' && credential.access.length > 0
        && typeof credential.securityToken === 'string' && credential.securityToken.length > 0);
}
/** 读当前凭据；不存在/损坏返回 undefined。 */
export function readStoredCredential(ref) {
    try {
        const raw = fs.readFileSync(storeFileFor(ref), 'utf8').replace(/^\uFEFF/, '');
        const j = JSON.parse(raw);
        if (typeof j.modelAppKey !== 'string' || j.modelAppKey.length === 0)
            return undefined;
        return j;
    }
    catch {
        return undefined;
    }
}
/** 写凭据（原子替换：先写 tmp 再 rename，防进程中途被杀留下半文件）。 */
function writeStoredCredential(credential, ref) {
    const target = storeFileFor(ref);
    fs.mkdirSync(officeaceHome(), { recursive: true });
    const payload = { ...credential, savedAt: new Date().toISOString() };
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, target);
}
/** 清除凭据（登出/刷新死循环时的自救入口）。 */
export function clearStoredCredential(ref) {
    try {
        fs.rmSync(storeFileFor(ref), { force: true });
    }
    catch { /* ignore */ }
}
// ────────────────────────── DPoP（复刻 OfficeAce oauth-crypto.js）──────────────────────────
function b64(buf) {
    return Buffer.from(buf).toString('base64url');
}
async function generateDpopKeyPair() {
    const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return {
        privateJwk: await webcrypto.subtle.exportKey('jwk', kp.privateKey),
        publicJwk: await webcrypto.subtle.exportKey('jwk', kp.publicKey),
    };
}
async function importDpopPrivateKey(jwk) {
    return webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
async function generateDpopJwt(privateKey, publicJwk, htm, htu, nowMs = Date.now()) {
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y, crv: publicJwk.crv } };
    const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: randomBytes(16).toString('hex') };
    const input = `${b64(Buffer.from(JSON.stringify(header)))}.${b64(Buffer.from(JSON.stringify(payload)))}`;
    const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(input));
    return `${input}.${b64(new Uint8Array(sig))}`;
}
/**
 * 步骤 1：向云侧注册 state 并生成授权 URL。
 *
 * `_internal` 由调用方保存在内存（`pendingOfficeAceState`），授权完成后传给
 * {@link completeLogin}。
 */
export async function startLogin() {
    // 1. 云侧登记 state（⚠️ 必须用云侧发的——自造的 state 回调后查不到）
    const stateRes = await fetch(`${CLAW_BASE}/v1/claw/auth/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
    });
    if (!stateRes.ok) {
        throw new Error(`华为云 state 注册失败：HTTP ${stateRes.status}`);
    }
    const state = (await stateRes.json()).state;
    if (typeof state !== 'string' || state.length === 0) {
        throw new Error('华为云未返回 state');
    }
    // 2. PKCE + 授权 URL
    const codeVerifier = b64(randomBytes(32));
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const { privateJwk, publicJwk } = await generateDpopKeyPair();
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        code_challenge: codeChallenge,
        code_challenge_method: 'SHA-256',
        state,
        scope: 'openid',
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
    });
    const authorizeUrl = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(`https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params.toString()}`)}`;
    return { authorizeUrl, state, _internal: { codeVerifier, dpopPrivateJwk: privateJwk } };
}
/**
 * 步骤 2：向云侧轮询 code（state 已登记时，用户授权后此端点返回 code）。
 *
 * @returns code；用户尚未授权时返回 undefined（前端继续轮询）。
 */
export async function pollLoginCode(state) {
    const r = await fetch(`${CLAW_BASE}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok)
        return undefined; // 202/404 = 未就绪
    try {
        const j = (await r.json());
        const code = j.code ?? j.data?.code;
        return typeof code === 'string' && code.length > 0 ? code : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 华为云 APIG 请求签名（AK/SK，SDK-HMAC-SHA256）。
 *
 * ⚠️ 逐字复刻 `@openjiuwen/relay-shared` 的 `Signer`（反编译对齐，三处坑全踩过）：
 *
 * 1. **canonical 路径强制尾斜杠**：`k()` 在末尾补 `/` —— 缺它就是
 *    `verify ak sk signature failed`（服务端回显 canonical 才发现）。
 * 2. **签名密钥就是裸 Secret**：`D()` 直接 `Hmac(SHA256, Secret)` 签
 *    StringToSign —— **没有** AWS 系的 scope 密钥派生（曾按 scope 派生，401）。
 * 3. **头名全小写排序**（`R()`），头值 trim（`w()`），GET 的 body 视为空。
 */
function signHuaweiRequest(method, url, headers, bodyText, accessKey, secretKey) {
    const u = new URL(url);
    const now = new Date();
    const pad = (n) => (n >= 10 ? String(n) : `0${n}`);
    const xdate = String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
        + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z';
    const urlEncode = (s) => encodeURIComponent(s);
    // k()：canonical URI —— 逐段 urlEncode 后 join，**末尾补 /**
    const canonicalUri0 = u.pathname.split('/').map((seg) => urlEncode(seg)).join('/');
    const canonicalUri = canonicalUri0.endsWith('/') ? canonicalUri0 : `${canonicalUri0}/`;
    // C()：query 排序拼接（本项目 GET 无 query，但实现保留）
    const queryPairs = [];
    for (const key of [...u.searchParams.keys()].sort()) {
        queryPairs.push(`${urlEncode(key)}=${urlEncode(u.searchParams.get(key) ?? '')}`);
    }
    const canonicalQuery = queryPairs.join('&');
    // 头：全小写 + host + x-sdk-date；值 trim
    const lower = {};
    for (const [k, v] of Object.entries(headers))
        lower[k.toLowerCase()] = v.trim();
    lower.host = u.host;
    lower['x-sdk-date'] = xdate;
    const signedHeaders = Object.keys(lower).sort();
    let canonicalHeaders = '';
    for (const h of signedHeaders)
        canonicalHeaders += `${h}:${lower[h]}\n`;
    const bodyHash = (method === 'PUT' || method === 'PATCH' || method === 'POST')
        ? createHash('sha256').update(bodyText).digest('hex')
        : createHash('sha256').update('').digest('hex');
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), bodyHash].join('\n');
    const stringToSign = ['SDK-HMAC-SHA256', xdate, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    // D()：签名密钥 = 裸 Secret
    const sig = createHmac('sha256', secretKey).update(stringToSign).digest('hex');
    return {
        ...headers,
        'X-Sdk-Date': xdate,
        Authorization: `SDK-HMAC-SHA256 Access=${accessKey}, SignedHeaders=${signedHeaders.join(';')}, Signature=${sig}`,
    };
}
/**
 * 步骤 4：code + verifier + DPoP 换 token。
 *
 * ⚠️ code 秒级时效 —— 轮询到后**立刻**调用本函数。
 */
async function exchangeToken(code, codeVerifier, dpopPrivateJwk) {
    const privateKey = await importDpopPrivateKey(dpopPrivateJwk);
    // DPoP 密钥对与 verifier 同批生成 —— 这里从 store 恢复不了（只有私钥 JWK），
    // 所以 publicJwk 从私钥 JWK 推回（同 crv/x/y，少 d 一项）。
    const publicJwk = { kty: 'EC', crv: 'P-256', x: dpopPrivateJwk.x, y: dpopPrivateJwk.y };
    const dpopJwt = await generateDpopJwt(privateKey, publicJwk, 'POST', TOKEN_URL);
    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
    });
    const r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
        body: body.toString(),
        signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    if (!r.ok) {
        throw new Error(`华为云 token 交换失败：HTTP ${r.status} ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
}
/**
 * 步骤 5：用 STS 凭据调 permission-validate，拿 modelInfo（推理凭据）。
 *
 * ## ⚠️ 未开通时**必须给出路**（IKM741 追补，2026-10-16 真机取证）
 *
 * 同一个华为号（手机号注册的根账号）在果办客户端点「开通」**前后**：
 * 云侧从 `subscription: null` 变成 `model_auth_info` 齐全（20:57 vs 21:16 实测）。
 * 而修前插件只回一句「账号可能未订阅 ModelArts MaaS」——**没有告诉用户怎么办**，
 * 用户为此在客户端里摸索了半天。故本条文案的**出路信息**是判据的一部分
 * （守卫见 `tests/unit/officeace-unsubscribed-guidance.spec.ts`）。
 *
 * ## ⚠️⚠️ 「自动开通」**刻意不做**（2026-10-16 真机证伪 + 用户明确否决依赖 ide）
 *
 * 曾经实现过一版自动开通（读果办客户端 CAS 落盘 profile、调 versatile 的
 * `/v1/agreement` + `/v1/claw/client-subscription`），真机三处请求全部
 * `401 APIGW.0301 invalid x-security-token` —— **根因是凭据来源**：versatile 只认
 * **CAS** 凭据，不认插件 OAuth（`client_id=pdp5_for_agentarts`）从 `sts.cn-north-4`
 * 换来的 STS。而三条可能的替代路径**没有一条能脱离果办客户端**：
 *
 * | 路径 | 卡在哪 |
 * |---|---|
 * | 借用客户端落盘的 CAS 凭据 + `client-subscription` | 能打通（HTTP 400 而非 401），但**新订阅要邀请码**（`AgentArts.11000008`） |
 * | `create-order` / `claim-bonus`（用户实际走的那条，**不要邀请码**） | 只有**客户端本地 API**（`127.0.0.1:3003/api/subscription/*`）暴露，需客户端进程与其会话 |
 * | 复刻 CAS 登录拿 ticket | ticket 只有客户端的**内嵌浏览器拦截导航**才拿得到，插件的系统浏览器拿不到 |
 *
 * ⇒ 插件**不读**果办客户端的落盘数据、**不调**它的本地 API、**不**碰 CAS 链条：
 * 开通这一步留在客户端（或华为云控制台）侧。完整证据链见
 * `docs/agent-notes/providers-officeace.md` 的「真机实测」一节。
 */
async function fetchModelInfo(credential) {
    const url = `${CLAW_BASE}/v1/claw/client-permission-validate`;
    const headers = {
        'content-type': 'application/json',
        'x-security-token': credential.securityToken,
    };
    if (credential.projectId)
        headers['x-project-id'] = credential.projectId;
    const signed = signHuaweiRequest('GET', url, headers, '', credential.access, credential.secret);
    const r = await fetch(url, { method: 'GET', headers: signed, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    if (!r.ok) {
        throw new Error(`华为云权限校验失败：HTTP ${r.status} ${text.slice(0, 200)}`);
    }
    const j = JSON.parse(text);
    const modelInfo = j.subscription?.model_info;
    const auth = modelInfo?.model_auth_info;
    if (typeof auth?.model_app_key !== 'string' || typeof auth?.model_app_secret !== 'string') {
        // ⚠️ 判据：**半截凭据**（只有 key 没有 secret）也算「未开通」——不许写半截凭据进号池。
        // ⚠️ 文案里的出路信息是**被测行为**，别删（守卫会红）。
        // ⚠️ **必须打标记**（2026-10-20 用户报障）：这条失败的出路在**果办客户端**
        //    （用该账号点「开通」并同意授权），重新点「+ 新建账号」只会重走一遍 OAuth
        //    然后再失败一次 ⇒ 登录收尾处**不得**给它拼「请重新点击「+ 新建账号」」
        //    那句**假出路**（判据与守卫见 `src/login-failure.ts`）。
        throw markLoginNeedsExternalAction(new Error('华为云未返回 MaaS 凭据：该账号尚未开通 ModelArts MaaS。'
            + '请先用该账号在果办客户端里点「开通」并同意授权，再回来重试。'));
    }
    credential.modelAppKey = auth.model_app_key;
    credential.modelAppSecret = auth.model_app_secret;
    const baseUrl = modelInfo?.model_api_url_base;
    credential.maasBaseUrl = typeof baseUrl === 'string' && baseUrl.length > 0
        ? `https://${baseUrl.replace(/^https?:\/\//, '')}`
        : OFFICEACE.defaultBaseUrl;
    credential.accountId = j.account_id ?? credential.accountId;
}
/**
 * 拉模型计费倍率（OfficeAce 主界面「模型选择器」里 `0.7x` 的数据源）。
 *
 * 端点：`GET {agentarts}/v1/model-token-rates`（V11 签名，2026-10-12 实测 200）。
 * 响应字段是 **snake_case**（`model_name` / `cost_coefficient`），与本地 API
 * 的 camelCase 形态不同 —— 这里做归一化。
 *
 * ⚠️ **不依赖 OfficeAce 客户端**（与余额同款 V11 直读）。
 * 凭据缺失 / 网络失败 → 空表：倍率显示优雅降级（模型照常可选，只是名字后不带 x 系数）。
 */
export async function fetchModelTokenRates() {
    const out = new Map();
    try {
        const credential = readStoredCredential();
        if (!credentialUsable(credential)) {
            return out;
        }
        const raw = await signAndGet(`${OFFICEACE.defaultBaseUrl.replace(/\/+$/, '')}/v1/model-token-rates`, credential);
        if (raw.length === 0)
            return out;
        const j = JSON.parse(raw);
        for (const m of j.models ?? []) {
            const name = typeof m.model_name === 'string' ? m.model_name
                : typeof m.modelName === 'string' ? m.modelName : undefined;
            const coeff = typeof m.cost_coefficient === 'number' ? m.cost_coefficient
                : typeof m.costCoefficient === 'number' ? m.costCoefficient : undefined;
            if (name !== undefined && coeff !== undefined)
                out.set(name, coeff);
        }
    }
    catch {
        // 凭据缺失 / 网络失败 → 空表（显示层降级）
    }
    return out;
}
/**
 * 读 OfficeAce 本地 API 的会话 cookie（`oc_sid`）。
 *
 * `~/.office-claw/session.cookie` 是 DPAPI 密文（`OC-DPAPI-1` 前缀），同一
 * Windows 用户可直接解密 —— 内容是 `{"value":"<签名cookie值>","expires":...}`。
 *
 * ⚠️ 仅用于**只读**的倍率查询（`/api/subscription/model-token-rates`）；
 * 登录/推理已不依赖 OfficeAce（见模块头）。未安装时返回 undefined → 倍率降级。
 */
export function readSessionCookie() {
    try {
        // ⚠️ 走 `officeAceClientHome()`（受 `DSH_OFFICEACE_HOME` 覆盖）而不是直接
        //    `os.homedir()`：否则单测会读到用户**真实**的 `.office-claw/session.cookie`
        //    （2026-10-14 对抗性审计实测：该文件真实存在且能解密成功）。
        const file = path.join(officeAceClientHome(), 'session.cookie');
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (!raw.startsWith('OC-DPAPI-1'))
            return undefined;
        const bare = raw.replace(/^OC-DPAPI-1\s*/, '');
        const script = '(Add-Type -AssemblyName System.Security);'
            + '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect('
            + `[Convert]::FromBase64String("${bare}"),$null,"CurrentUser"))`;
        const clear = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            timeout: 15_000,
            encoding: 'utf8',
        }).trim();
        const parsed = JSON.parse(clear);
        return typeof parsed.value === 'string' && parsed.value.length > 0 ? parsed.value : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 完成登录：code → token → modelInfo → **返回凭据（不落盘）**。
 *
 * ⚠️ 必须在轮询到 code 后**立刻**调用（code 秒级时效）。
 *
 * ⚠️ **落盘由调用方通过 {@link persistLogin} 完成**（与 gemini / raccoon /
 *    minimax 同款 `persistLogin(credential, { refName })` 范式）：凭据存进
 *    DSH 凭据库并按 `credentialRef` 索引 —— **这才是号池能多账号的根**。
 *    本文件早先自己写了 `session.json`，那是绕开凭据库的孤岛，正是
 *    「第二条卡片覆盖第一条」的成因（2026-10-13 改造）。
 *
 * ⚠️ 兼容：仍在**默认文件**写一份（`session.json`），供尚未走凭据库的
 *    老调用点与 `probeOfficeAce` 读取。多账号路径**不依赖**它。
 */
export async function completeLogin(code, codeVerifier, dpopPrivateJwk) {
    const token = await exchangeToken(code, codeVerifier, dpopPrivateJwk);
    const c = token.credentials;
    const credential = {
        modelAppKey: '',
        modelAppSecret: '',
        maasBaseUrl: OFFICEACE.defaultBaseUrl,
        access: c.access_key_id,
        secret: c.secret_access_key,
        securityToken: c.security_token,
        projectId: c.project_id ?? '',
        expiresAt: c.expiration,
        refreshToken: token.refresh_token ?? '',
        dpopPrivateJwk,
    };
    await fetchModelInfo(credential);
    return credential;
}
/**
 * 落库凭据（登录成功后由 RPC 调用）—— **DSH 标准范式**。
 *
 * 与 `gemini-auth.ts` / `raccoon-auth.ts` / `minimax-auth.ts` 的
 * `persistLogin(credential, { refName })` **同款**：
 * `ctx.credentials.set(credentialRef(refName), JSON.stringify(credential))`。
 *
 * ⚠️ 凭据按 `refName` 索引进 DSH 凭据库 ⇒ 每个账号一份，**互不覆盖**，
 *    号池多账号/轮换天然成立。这是与「自己写 session.json」的本质区别。
 */
export async function persistLogin(credential, options) {
    await options.credentials.set(credentialRef(options.refName), JSON.stringify(credential));
    // 兼容：老调用点（probe / 面板状态探测）仍读默认文件，顺手写一份。
    try {
        writeStoredCredential(credential);
    }
    catch { /* 兼容路径失败不影响主流程 */ }
    return credential.accountId === undefined ? {} : { accountId: credential.accountId };
}
/**
 * 按 ref 读凭据（**优先 DSH 凭据库**，再回落**本 ref** 的兼容文件）。
 *
 * ⚠️ 这个次序不能反：多账号下每个账号的凭据在凭据库里按 ref 索引，
 *    `session.json` 只是老数据的兼容兜底 —— 先读文件会串号。
 *
 * ## ⚠️⚠️ 兜底**必须带 `ref`**（Gitee issue IKM741，2026-10-16 实测确证）
 *
 * 这里原先写的是 `readStoredCredential()` —— **漏传了 `ref`**，于是它读的是那份
 * **全局唯一**的 `session.json`（语义 =「最后一次登录的那个账号」）。而本函数
 * 的**每一个**调用方都传了 ref（`refreshAccountCredential` / `latestAfterFailedRefresh`
 * / `fetchSubscriptionSummary` / `index.ts` 的两处）⇒ 这个「不带 ref 的兜底」
 * 没有任何调用方需要它，纯粹是串号源。这正是 AGENTS.md 记的
 * 「位置/键错位」那一类缺陷的又一次复发（把 ref 丢在调用边上）。
 *
 * 实测后果（`~/.dsh` 四个账号三条已无凭据的真实机器）：
 *
 * | 情形 | 修前 | 修后 |
 * |---|---|---|
 * | 库里**有**该 ref | 用它 | 用它（不变） |
 * | 库里**无**该 ref，但有 `session-<ref>.json` | 读它（不变） | 读它（不变） |
 * | 库里**无**该 ref，也没有该 ref 的兼容文件 | **读全局 `session.json`** ⇒ 把**别的账号**的凭据当成本账号的 | `undefined`（如实报「本账号无凭据」） |
 *
 * 第三格是三条真实故障的**同一个根因**：
 *
 * 1. **跨账号烧一次性 `refresh_token`**：`refresh_token` 是一次性的，而
 *    `session.json` 是全局单份 ⇒ N 个「有账号无凭据」的账号各自回落到**同一份**
 *    token、各自拿它去续期 ⇒ 第一个消费掉，其余全部收到
 *    `STS5.1806 has been used`（issue 补充评论里的三条日志逐字如此）。
 *    危害是**跨账号**的：一份坏账号能把别的健康账号的路堵掉。
 * 2. **读数串号**：`fetchSubscriptionSummary(48, ref, …)` 拿全局凭据走云侧直读
 *    ⇒ 把最后一个登录账号的余额显示成本账号的余额（正是
 *    `ProviderExpiryContext.credentialRef` 那段注释记录的形态）。
 * 3. **`expiresAt` 串号**：`account.list` 的逐账号回填读到的是全局那份。
 *
 * ⚠️ 兼容性：改成按 ref 后，**单凭据老用户零行为变化** —— 那条路径本来就
 *    不经过本函数（它由 `readStoredCredential()` 无参调用点承担，如
 *    `probeOfficeAce` / `readOfficeAceCredential` / `fetchModelTokenRates`）。
 *    本函数只服务多账号路径，而多账号路径**必须**按 ref。
 */
export async function readCredential(ref, credentials) {
    if (credentials !== undefined) {
        try {
            const resolved = await credentials.resolve(credentialRef(ref));
            if (resolved !== undefined && resolved.value.length > 0) {
                const parsed = JSON.parse(resolved.value);
                if (typeof parsed.modelAppKey === 'string' && parsed.modelAppKey.length > 0)
                    return parsed;
            }
        }
        catch { /* 解析失败 → 回落**本 ref** 的兼容文件（见上方注释） */ }
    }
    return readStoredCredential(ref);
}
// ────────────────────────── 刷新 ──────────────────────────
/**
 * 用 refresh_token 续期（STS + modelInfo 全链）。
 *
 * ⚠️ refresh_token **一次性**：成功后必须立即落盘（见模块头注释的死循环教训）。
 *
 * ⚠️ **并发互斥**（2026-10-12 事故的根因加固）：refresh_token 一次性 ——
 *    两个并发调用（如续期调度器 + 用户点刷新）带着**同一个** token 同时打到
 *    STS，先到的消费掉、后到的拿 STS5.1806；若先到的写盘前被中断（用户停轮 /
 *    进程退出），新 token 就**永久丢失**，唯一出路是重新登录。故这里用模块级
 *    in-flight Promise 把并发调用合并为一次：后到者直接等先到者的结果。
 *
 * @returns 新凭据；refresh_token 失效（STS5.1806）返回 undefined（需重新登录）。
 */
// ⚠️ **按 ref 分桶**：不同账号的 refresh_token 互不相干，合并到同一个
//    in-flight 会让「A 正在续期」把 B 的续期也挡住（B 白白等到 A 完成，
//    且拿回的是 A 的结果 —— 在多账号下这是错值，不只是延迟）。
const refreshInFlight = new Map();
export function refreshStoredCredential(ref) {
    const key = ref ?? '';
    const pending = refreshInFlight.get(key);
    if (pending !== undefined)
        return pending;
    const task = doRefreshStoredCredential(ref).finally(() => { refreshInFlight.delete(key); });
    refreshInFlight.set(key, task);
    return task;
}
async function doRefreshStoredCredential(ref) {
    const current = readStoredCredential(ref);
    if (current === undefined || current.refreshToken.length === 0)
        return undefined;
    const next = await doRefreshCredential(current);
    if (next === undefined)
        return undefined;
    // STS 刷新成功即旧 refresh_token 作废 —— 立即落盘（顺序不能反）
    writeStoredCredential(next, ref);
    return next;
}
/**
 * 续期**一份已读入内存的凭据**（纯协议：STS 交换 + modelInfo），**不落盘**。
 *
 * ⚠️ 抽出来的原因：凭据可能来自 DSH 凭据库（`refreshAccountCredential` 的
 *    多账号路径），也可能来自兼容文件（老数据）。落盘职责留给调用方 ——
 *    否则写回凭据库的凭据会被顺手再写一份到 `session.json`，重新制造串号。
 */
async function doRefreshCredential(current) {
    if (current.refreshToken.length === 0)
        return undefined;
    const privateKey = await importDpopPrivateKey(current.dpopPrivateJwk);
    const publicJwk = { kty: 'EC', crv: 'P-256', x: current.dpopPrivateJwk.x, y: current.dpopPrivateJwk.y };
    const dpopJwt = await generateDpopJwt(privateKey, publicJwk, 'POST', TOKEN_URL);
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: CLIENT_ID,
    });
    const r = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
        body: body.toString(),
        signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
        // ⚠️ **必须留痕**（仓库约定：失败不允许静默吞掉）。此前这里静默
        //    `return undefined`，refresh_token 被消费丢失（STS5.1806）时日志零字，
        //    用户只看到「渠道停了 / 余额不更新」，无从排查（2026-10-12 事故实测）。
        const detail = await r.text().catch(() => '');
        console.warn(`[officeace] STS 续期失败 HTTP ${r.status}：${detail.slice(0, 200)}`
            + '（refresh_token 是一次性的：若报 STS5.1806 已被消费，必须重新登录才能恢复云端 API）');
        return undefined;
    }
    const token = (await r.json());
    const c = token.credentials;
    const next = {
        ...current,
        access: c.access_key_id,
        secret: c.secret_access_key,
        securityToken: c.security_token,
        projectId: c.project_id ?? current.projectId,
        expiresAt: c.expiration,
        refreshToken: token.refresh_token ?? current.refreshToken,
    };
    // ⚠️ **不落盘**（由调用方负责）：本函数只做协议交换。
    //    modelInfo 里的 MaaS 凭据也随之更新（可能轮换）。
    try {
        await fetchModelInfo(next);
    }
    catch {
        // modelInfo 拉取失败不回滚 STS：推理凭据可能仍有效
    }
    return next;
}
/**
 * 「按账号续期」入口 —— 满足 `JetHubAuthLike` 的形状，供
 * `account.refresh` / 批量续期表 / `provider-runtime` 统一分派。
 *
 * ## ⚠️ `refName` **必须真正生效**（2026-10-13 修正）
 *
 * 原注释写的是「OfficeAce 是单凭据文件，故忽略 refName」—— 那是**凭据共用**
 * 这个缺陷的伴随假设。凭据改为**按 ref 分文件**后，多账号天然共存，这里就
 * 必须按 `refName` 定位到那一份文件去续期；否则 N 个账号会把同一份凭据
 * 续期 N 次（后 N-1 次拿到 STS5.1806 —— refresh_token 一次性已被消费）。
 *
 * ⚠️ 返回值恒 `undefined`（`void` 语义）：续期成功与否由**调用方后续读凭据**
 * 判定，这里不抛错 —— 与其余渠道一致（失败不阻断批量续期）。
 *
 * ## ⚠️⚠️⚠️ per-ref 串行 + 锁内重读 + 终态前重读（2026-10-13 审计补齐）
 *
 * 模块头（`:30-31`）自己写明 `refresh_token` **一次性**，而三条续期入口
 * （定时器 `refreshAll` / 适配器 401 兜底 / 面板 `account.refresh` 与自愈）
 * 都会并发进入**同一个 ref**。原先这里直连 `doRefreshCredential` ⇒
 * 先到者消费掉 token、后到者拿 STS5.1806；更糟的是若先到者写盘前被中断，
 * **新 token 永久丢失、只能重新登录**。
 *
 * ⚠️ 原先的 `refreshInFlight` 闸只包住了 `refreshStoredCredential`
 * （**兼容的文件那条腿**），生产主路径完全绕过它 —— 「加了锁但加错了一条腿」。
 *
 * 三条规则**必须一起**（同 codearts；AGENTS.md 记过「只搬第一条会继续误标」）：
 * 1. **per-ref 串行**（`SerialQueue`）：同进程内三条入口必然串行；
 * 2. **锁内重读 + lead-time**：拿到锁时凭据可能已被上一轮换新，距过期还早时
 *    只对账池值、**不发第二次请求**（少烧一个一次性 token）；
 * 3. **判终态前重读**：续期被拒时先看磁盘那份 `refresh_token` 是否**已经不等于**
 *    本次用的那份 —— 并发下服务端烧掉的是**旧的**一份，磁盘上此刻躺着**新的、
 *    可用的**凭据，那是「他处已续成功」而不是「本账号不可续期」。
 *
 * ⚠️ 该锁**只在单进程内有效**（dsh web 与 desktop 各自持锁），
 * 跨进程互踩靠上面第 3 条兜 —— 两处都得有。
 */
export async function refreshAccountCredential(refName, pool, accountId, credentials) {
    await queueFor(refName).run(async () => {
        // ⚠️ **锁内重读**（规则 2）：等锁期间上一轮可能已换好凭据并落盘。
        const current = await readCredential(refName, credentials);
        if (current === undefined) {
            const legacy = await refreshStoredCredential(refName).catch(() => undefined);
            await writebackExpiry(legacy, pool, accountId);
            return;
        }
        // ⚠️ **lead-time 判据**（规则 2 的另一半）：STS 凭据寿命约 2 小时，
        //    而定时器每 30 分钟跑一轮 —— 无条件续期等于**每 30 分钟烧掉一个
        //    一次性 refresh_token**（一天 48 次），且每次还捎带一次
        //    `fetchModelInfo` 的签名请求。距过期还早时只对账池值、不发请求。
        if (!shouldRefreshNow(officeaceExpiresAtMs(current))) {
            await writebackExpiry(current, pool, accountId);
            return;
        }
        const next = await doRefreshCredential(current);
        if (next === undefined) {
            // ⚠️ **判终态前重读**（规则 3）：先确认「是不是别处已经续成功了」。
            const elsewhere = await latestAfterFailedRefresh(refName, credentials, current);
            await writebackExpiry(elsewhere, pool, accountId);
            return;
        }
        if (credentials !== undefined) {
            try {
                await credentials.set(credentialRef(refName), JSON.stringify(next));
            }
            catch { /* 写回失败不阻断 */ }
        }
        else {
            writeStoredCredential(next, refName);
        }
        await writebackExpiry(next, pool, accountId);
    });
}
/**
 * per-`credentialRef` 的串行队列（与 codearts 的 `refreshQueues` 同型）。
 *
 * ⚠️ 队列表**必须有上限**：账号可被反复增删，无界 Map 会缓慢泄漏。
 */
const refreshQueues = new Map();
function queueFor(refName) {
    const existing = refreshQueues.get(refName);
    if (existing !== undefined)
        return existing;
    const created = new SerialQueue();
    if (refreshQueues.size >= 64) {
        // ⚠️ 超额时先淘汰**最早创建**的那个（Map 保序）—— 丢一把锁只是退回
        // 「并发窗口」这个既有形态，不会丢凭据、也不会抛错。
        const oldest = refreshQueues.keys().next();
        if (!oldest.done)
            refreshQueues.delete(oldest.value);
    }
    refreshQueues.set(refName, created);
    return created;
}
/** 凭据里读到的过期时刻（毫秒）；读不到/非法返回 `undefined`（⇒ 需要续期）。 */
function officeaceExpiresAtMs(credential) {
    // ⚠️ 华为 STS 的 `expiration` 是 **ISO 8601 字符串**（不是数值时间戳），
    //    故这里**不需要** buddy / accio 那条秒→毫秒归一化，也不是一个 bug。
    const parsed = Date.parse(credential.expiresAt);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
/**
 * 续期失败后判断「是不是别处已经续成功了」。
 *
 * 并发/跨进程下，服务端烧掉的是**旧的**那份 `refresh_token`，而此刻磁盘上
 * 可能正躺着一份**新的、可用的**凭据 —— 那是「他处已续成功」，不是本账号失效。
 * 少了这层判据，一次交错就会把好账号永久标死（与 codearts 同型事故）。
 *
 * @returns 磁盘上那份**更新**的凭据；若确实没有更新则 `undefined`（真终态）。
 */
async function latestAfterFailedRefresh(refName, credentials, attempted) {
    const latest = await readCredential(refName, credentials).catch(() => undefined);
    if (latest === undefined)
        return undefined;
    if (latest.refreshToken === attempted.refreshToken)
        return undefined;
    // ⚠️ 只在「换过 token」且「新 token 尚未过期」时才认为他处续成功；
    //    一份同样已过期的凭据不该被当成好消息。
    const exp = officeaceExpiresAtMs(latest);
    if (exp === undefined || Date.now() >= exp)
        return undefined;
    return latest;
}
/** 把新有效期写回账号池条目（与 gemini 同款），抽出来供两条路径复用。 */
async function writebackExpiry(next, pool, accountId) {
    // ⚠️ 续期成功后**必须把新有效期写回池条目**：漏写时卡片「有效期」停在旧值
    //    直至显示「已过期」（真实症状 2026-10-13）。
    if (next === undefined)
        return;
    const p = pool;
    try {
        await p?.updateAccount?.(accountId, { expiresAt: new Date(next.expiresAt).getTime() });
    }
    catch {
        // 写回失败不阻断续期（凭据已落盘，下次刷新会再试）
    }
}
/**
 * 遍历账号池逐个续期（`refreshAll` 的**唯一**一份实现）。
 *
 * ## ⚠️⚠️ 为什么抽出来而不是让两处各写一遍（IKLPTZ 的真实成因）
 *
 * 生产里有**两个** `refreshAll`：模块导出的这个，与 `src/index.ts` 里包在
 * `officeaceAuthService` 上的那个（定时器实际走后者 —— `ctx.credentials`
 * 只能在那里注入）。两者除「分派目标」外**逐字相同**，于是 IKLPTZ 那个
 * `.catch()` 误判被**复制了两遍**，修 bug 也要修两处。
 *
 * ⇒ 把「取账号 → 判空 → 兜底」收成这里一份，两处只提供各自的
 * `refreshOne` 分派（这正是 `trae-model-id-selection.spec.ts` 那条守卫
 * 要断言的语义：续期必须打到**每个账号自己的** ref）。
 *
 * ## ⚠️ 形状契约（勿改）
 *
 * - **必须逐个账号续期**，不能图省事直接调 {@link refreshStoredCredential}：
 *   后者绕过账号池 ⇒「续期后不回写 `expiresAt`」，界面有效期停在旧值。
 * - **不看 `enabled`**（AGENTS.md 既有铁律）：停用只影响自动选号，与凭据
 *   新鲜度无关。故这里**刻意不过滤**。
 * - 拿不到池 / 池里 0 个账号 ⇒ 退化为续期本机那一份凭据（老用户兼容路径）。
 * - 池读取**同步抛错**不阻断：按「0 个账号」处理并走同一条兜底。
 *
 * ## ⚠️⚠️ 登记一处**刻意的行为变更**（2026-10-14 复审实测确认，别当等价重构）
 *
 * 本函数**不是**对修复前那两段代码的逐格等价重构 —— 有**一格**确实变了：
 * 「`listAccountsByProvider` **同步抛错**」。
 *
 * | | 修复前（`await ….catch(…)`） | 现（`try/catch`） |
 * |---|---|---|
 * | 池返回 rejected Promise | 吞成 `[]` ⇒ 走兜底 | 走兜底（等价） |
 * | 池**同步 throw** | **逃逸出 `refreshAll`** ⇒ 被上层 `refreshAllCredentials` 的逐 provider `try` 记一条 warn | **吞成 `[]`** ⇒ 走兜底 |
 *
 * 原因是 `.catch()` 只接 Promise 的 rejection，接不住同步 throw（已实测：
 * `await p.listAccountsByProvider('x').catch(()=>[])` 在同步 throw 下**抛出**）。
 *
 * ⚠️ **这个变更是刻意的、方向正确的**：`refreshAllCredentials` 的语义是
 * 「单个 provider 失败不阻断其余」，而「读池抖动」不该让 OfficeAce 整条
 * 从续期表里消失（那正是 IKLPTZ 的可观测症状）。故归入「空池兜底」比逃逸更好。
 * ⚠️ 但**必须按本仓库惯例登记**（见 `provider-abstraction-g3-exceptions.md`：
 * 「登记了一处例外」不等于它没有守卫）—— 守卫是 `officeace-refresh-all.spec.ts`
 * 的用例⑤（断言读池抛错时 `fallbackRefresh` **真的被调用一次**；
 * 改成静默 `return` 即变红）。
 *
 * ## ⚠️ `fallbackRefresh` 为什么是**参数**
 *
 * 它的生产默认值就是 {@link refreshStoredCredential}（语义与从前逐字相同）。
 * 提成参数是为了让单测能**替换掉那个会碰 `~/.dsh-officeace/session.json`
 * 的入口**：那个文件是用户**真实的华为云凭据**，而 `refresh_token` 是一次性的
 * —— 用例若顺着兜底分支读进去并发一次 STS，就会**消费掉用户的一次性 token**
 * （实测踩到过：vitest 输出里出现真实报文 `STS5.1806 has been used`）。
 * 注入之后，「空池」那几条用例完全不碰文件系统与网络。
 */
export async function refreshAccountList(pool, refreshOne, fallbackRefresh = refreshStoredCredential) {
    let accounts;
    try {
        // ⚠️⚠️ **`await` 一次是必须的，且不能省**（2026-10-14 对抗性审计打穿后修正）：
        //    生产池是同步的（`await` 数组是恒等操作，无额外开销），而**Promise 形态
        //    也必须能跑** —— 第一版按「只接受同步」写，于是 Promise 池会掉进
        //    `for…of` 抛 `TypeError: accounts is not iterable`，**连兜底都绕过**，
        //    比修复前的行为更糟（旧代码 `await ….catch(…)` 是能处理 Promise 的）。
        //    实测对照见 `OfficeAceRefreshPool` 接口注释里的表。
        const listed = pool?.listAccountsByProvider?.('officeace');
        const resolved = await listed;
        // ⚠️ 非数组（形状不符 / 桩写错）⇒ 当「没有账号」：走兜底并**不抛**。
        //    这里刻意不抛 TypeError —— 一个渠道的桩写错不该让整轮续期炸掉。
        accounts = Array.isArray(resolved) ? resolved : [];
    }
    catch {
        // 同步 throw 或 rejected Promise ⇒ 与「没有账号」同处理，不阻断整轮续期。
        // ⚠️ **同步 throw 是一处刻意的行为变更**（修复前它会逃逸出本函数）——
        //    理由与守卫见上方「登记一处刻意的行为变更」一节，别当等价重构删掉。
        accounts = [];
    }
    if (accounts.length === 0) {
        // 拿不到池（极少见：单测桩不完整）或尚未登录 ⇒ 退化为续期那一份。
        await fallbackRefresh().catch(() => undefined);
        return;
    }
    for (const account of accounts) {
        await refreshOne(account);
    }
}
/**
 * 批量续期（`refreshAll` 形状）。
 *
 * ⚠️ 实现见 {@link refreshAccountList} —— 本函数只负责把「续期某一个账号」
 * 分派到**本模块**的 {@link refreshAccountCredential}（走兼容文件那条腿）。
 * `src/index.ts` 的服务包装会调同一个 {@link refreshAccountList}，但把
 * 分派指向**注入了 `ctx.credentials`** 的那一份。
 *
 * ⚠️ **把 `pool` 原样透传给 `refreshAccountCredential`**（不能省）：续期成功后
 * 要靠它回写池里的 `expiresAt`，漏传的症状是卡片有效期永远不更新。
 */
export async function refreshAll(pool) {
    await refreshAccountList(pool, (account) => refreshAccountCredential(account.credentialRef, pool, account.id));
}
/**
 * 订阅缓存的落盘路径（余额离线兜底用，与凭据同目录）。
 *
 * ⚠️ **按 ref 分文件**（2026-10-13）：多账号下若共用一个缓存文件，
 *    后查的账号会把先查的余额盖掉 ⇒ 所有卡片显示最后一次查询的结果。
 */
function subscriptionCacheFile(ref) {
    if (ref === undefined || ref.length === 0) {
        return path.join(officeaceHome(), 'subscription-cache.json');
    }
    return path.join(officeaceHome(), `subscription-cache-${ref.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}
function readSubscriptionCache(ref) {
    try {
        const j = JSON.parse(fs.readFileSync(subscriptionCacheFile(ref), 'utf8').replace(/^\uFEFF/, ''));
        if (typeof j.totalCredits !== 'number')
            return undefined;
        return j;
    }
    catch {
        return undefined;
    }
}
function writeSubscriptionCache(summary, ref) {
    try {
        fs.mkdirSync(officeaceHome(), { recursive: true });
        const payload = { ...summary, cachedAt: new Date().toISOString() };
        const target = subscriptionCacheFile(ref);
        const tmp = `${target}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmp, target);
    }
    catch { /* 缓存失败不影响主流程 */ }
}
/**
 * 读 OfficeAce 订阅摘要（果办界面右上角的积分池）。
 *
 * ## 离线兜底（2026-10-12）：**不依赖 OfficeAce 运行**
 *
 * 在线时（cookie 可用且端口通）拉实时数据并**写缓存**；离线时读**最近一次
 * 缓存**兜底（`stale: true` 标记，展示层据此标注「数据截至 hh:mm」）。
 * 推理本身从不依赖此函数——余额只是展示。
 *
 * ## ⚠️ 多账号（2026-10-13）：查**哪个**账号由入参决定
 *
 * 传了 `credential` / `ref` 时**优先走云侧 V11 直读** —— 因为下面的本地 API 走
 * 的是果办客户端的**全局单一 cookie**（`oc_sid`），它只反映「当前登录在果办里的
 * 那一个账号」，**无法按 ref 区分** ⇒ 多账号下会让所有卡片显示同一个账号的
 * 余额（实测两个账号都显示 6500）。故多账号**必须**走云侧。
 *
 * @param staleHours - 缓存超过多少小时视为过期（默认 48）。过期且在线拉取
 *   失败时仍返回缓存（聊胜于无），由 `stale` 标记让 UI 如实呈现。
 * @param ref - 账号的 credentialRef（用于定位缓存文件）。
 * @param credential - 直接注入凭据（**多账号最可靠**：免一次解析，且明确指向某账号）。
 * @param credentials - DSH 凭据库；给了就按 `ref` 从库里读（多账号标准路径）。
 */
export async function fetchSubscriptionSummary(staleHours = 48, ref, credential, credentials) {
    // 0. **多账号路径**：有 ref 时先走云侧直读（本地 cookie 无法区分账号）。
    //    成功即返回，不落到下面的本地 API —— 那会串号。
    if (ref !== undefined && ref.length > 0) {
        /**
         * ⚠️⚠️ **凭据不存在 ⇒ 如实报「未登录」，绝不用陈旧缓存充数**
         * （Gitee issue IKM741 修法 C，2026-10-16 实测确证）。
         *
         * 修前这里是一个 `try{}catch{}` 罩住「读凭据 + 云侧直读」，catch 之后
         * **无条件**落到该 ref 的缓存兜底 ⇒ 三种失败被混成一件事：
         *
         * | 情形 | 修前读数 | 修后 |
         * |---|---|---|
         * | 凭据在、云侧临时不可达 | 该 ref 的缓存（`stale:true`，合理） | 不变（**保留**，这是「数据截至 hh:mm」的正当用法）|
         * | **凭据已不存在**（孤儿账号） | **仍报出一个数字** | `undefined` ⇒ 面板显示「未登录」|
         *
         * 第二格正是 issue 的核心误导（实测复现）：那 3 条「有账号无凭据」的账号
         * 面板照样显示 6493.32 / 6500 这类数字，用户据此认为「账号正常、还有额度」，
         * 而它**已经没有任何凭据**、在聚合里恒 `UNUSABLE`。数字来源是登录时写下的
         * **快照**（`subscription-cache-<ref>.json`，本机那几份的 `cachedAt` 是
         * 10-13 / 10-14，而凭据早就没了）。
         *
         * ⇒ 判据：**读数必须与凭据绑定** —— 凭据在，读数才有意义（含它的陈旧缓存）；
         * 凭据不在，唯一诚实的答案是「未登录」，宁可显示失败也不显示一个假数字。
         */
        const own = credential ?? await readCredential(ref, credentials).catch(() => undefined);
        if (own === undefined)
            return undefined;
        try {
            // ⚠️ **先自动签到再查余额**（顺序不能反）：签到会把当日 1000 分打进
            //    `bonus_skus`，先查就永远少显示那一份 —— 用户会以为没领到。
            //    `maybeClaimBonus` 内部按小时去重，不会重复打服务端。
            await maybeClaimBonus(own, ref);
            const cloud = await fetchCloudSubscriptionFor(own);
            if (cloud !== undefined) {
                writeSubscriptionCache(cloud, ref);
                return cloud;
            }
        }
        catch { /* 凭据在、只是云侧暂时读不到 ⇒ 掉到「本 ref」的缓存兜底 */ }
        const cached = readSubscriptionCache(ref);
        if (cached !== undefined)
            return { ...cached, stale: true };
        return undefined;
    }
    // 1. **主路径：OfficeAce 本地 API**（装了客户端且在运行时可用，实测稳定）
    try {
        const sidValue = readSessionCookie();
        if (sidValue !== undefined) {
            const caCandidates = [
                // ⚠️ 同上：受 `DSH_OFFICEACE_HOME` 覆盖，避免单测读用户真实证书目录。
                path.join(officeAceClientHome(), 'certs', 'root-ca.pem'),
                'D:\\Users\\Z\\AppData\\Local\\Programs\\OfficeAce\\.office-claw\\certs\\root-ca.pem',
            ];
            let ca;
            for (const p of caCandidates) {
                try {
                    ca = fs.readFileSync(p);
                    break;
                }
                catch { /* 下一个候选 */ }
            }
            if (ca !== undefined) {
                const body = await new Promise((resolve) => {
                    const req = https.request({ host: '127.0.0.1', port: 3004, path: '/api/subscription/current', method: 'GET', headers: { cookie: `oc_sid=${sidValue}`, accept: 'application/json' }, ca }, (x) => {
                        let d = '';
                        x.on('data', (c) => (d += c));
                        x.on('end', () => resolve(d));
                    });
                    req.on('error', () => resolve(''));
                    req.setTimeout(15_000, () => { req.destroy(); resolve(''); });
                    req.end();
                });
                if (body.length > 0) {
                    const j = JSON.parse(body);
                    if (typeof j.totalCredits === 'number') {
                        const summary = {
                            planName: j.planName,
                            totalCredits: j.totalCredits,
                            usedCredits: j.usedCredits ?? 0,
                            creditGroups: Array.isArray(j.creditGroups) ? j.creditGroups : [],
                        };
                        writeSubscriptionCache(summary);
                        return summary;
                    }
                }
            }
        }
    }
    catch { /* 掉到云侧直读，再掉到缓存 */ }
    // 2. **实验路径：云侧直读**（V11 签名，不依赖 OfficeAce——签名尚未完全对齐，
    //    服务端返 APIG.0301；保留实现供后续对齐，失败自动落到缓存）
    try {
        const cloud = await fetchCloudSubscription();
        if (cloud !== undefined) {
            writeSubscriptionCache(cloud);
            return cloud;
        }
    }
    catch { /* 掉到缓存兜底 */ }
    // ⚠️ 云侧直读失败时**不要**跨账号兜底：读 `ref` 的缓存，没有就是没有
    //（退回全局缓存会把 A 的余额显示成 B 的，比显示「查询失败」更糟）。
    // 3. 离线兜底：最近一次缓存（标注 stale）
    const cached = readSubscriptionCache();
    if (cached === undefined)
        return undefined;
    // 超过 staleHours 的缓存照常返回——余额数字聊胜于无，UI 用 stale 标记说明
    void staleHours;
    return { ...cached, stale: true };
}
/**
 * V11 签名的 GET 请求（华为 APIG 私有算法，逐字复刻 OfficeAce 的
 * `chunk-XOTX5NN5.js` 的 `B()`/`F()`）。
 *
 * ## 三条**必须**记住的规则（每条都曾导致 401，别再凭直觉改）
 *
 * 1. **头集合**：GET 请求**不发 `Content-Type`**（OfficeAce 的 `cloudFetch` 只在
 *    `method !== 'GET'` 时设置它）。多这一个头，签名串就多一行，服务端重算必不匹配。
 * 2. **密钥派生**（`z(accessKey, secretKey, scope)`）：
 *    `u = HMAC(sha256, accessKey).update(secretKey)`；
 *    `a = scope 字节 + 0x01`；`derive = HMAC(sha256, u).update(a)` 取**前 32 字节**。
 *    最后**以 derive 的 hex 字符串（不是 raw bytes）作为 key** 签 stringToSign。
 * 3. **分隔符**：canonical 头行与 stringToSign 都是 **LF** 分隔（不是空格）；
 *    canonical 路径**强制尾斜杠**。
 *
 * @returns 响应正文；非 2xx 或异常返回空串（调用方按「读不到」降级）。
 */
/**
 * V11 签名的请求 —— **GET 与 POST 共用**。
 *
 * ⚠️ POST 与 GET 的**唯一**差异是 `Content-Type` 是否进入签名头集合
 * （规则 1：GET 不带），以及 body 参与 payload 哈希。其余（密钥派生、
 * LF 分隔、尾斜杠）完全一致 —— 故抽成一个函数，避免两处签名逻辑漂移
 * （那正是当初 GET 反复 401 的成因）。
 *
 * @param body - 请求体文本；`undefined`（无 body）时按空串计哈希。
 * @param statusOut - 可选：写入终态 HTTP 状态码。
 * @param errorBodyOut - 可选：写入**失败响应体原文**（供调用方带出唯一出路信息）。
 *
 * ⚠️ **返回值对「失败」是有歧义的**：非 2xx 与「2xx 但响应体为空」都给出空串
 *    （`r.ok ? await r.text() : ''`）。余额查询可以容忍（空串 ⇒ 解析失败 ⇒
 *    走缓存兜底），但**签到不能** —— 401 会被读成「今天没有可领的」，
 *    于是每天白丢 1000 分且日志无痕（2026-10-18 真实报障）。需要区分的调用方
 *    传 `statusOut` 自行判定。
 *
 * ⚠️⚠️ **`errorBodyOut` 不是冗余**（2026-10-18 审计实测的 P1）：
 *    失败时返回值恒为空串，于是上游那行 `body.slice(0, 120)` **永远切出空串** ——
 *    实测 401 + `{"error":"IAM_TOKEN_EXPIRED_XYZ"}` 得到的是
 *    `reason: "HTTP 401："`，**服务端报文全丢**。
 *    而「报文本身指路」正是本 PR 立论所依赖的东西（同理 IKLBSH 记录的
 *    `AUTH` 码吞 message：文案就是出路，丢了就无从处置）。
 *    本文件另有两处**既有先例**是「先 `await r.text()` 再判 `!r.ok`、把报文带进
 *    错误/日志」（`exchangeIamToken` 与 STS 续期失败）—— 此处照同一口径补齐。
 */
async function signAndRequest(url, credential, method, body, statusOut, errorBodyOut) {
    const region = 'cn-southwest-2';
    const service = 'apic';
    const pad = (n) => (n >= 10 ? String(n) : `0${n}`);
    const now = new Date();
    const xdate = String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
        + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z';
    const urlEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const u = new URL(url);
    // N()：canonical 路径 —— 逐段编码后 **强制尾斜杠**
    const canonicalUri0 = u.pathname.split('/').map((s) => urlEncode(decodeURIComponent(s))).join('/');
    const canonicalUri = canonicalUri0.endsWith('/') ? canonicalUri0 : `${canonicalUri0}/`;
    // P()：query 排序拼接（当前端点无 query，实现保留）
    const queryPairs = [];
    u.searchParams.forEach((v, n) => queryPairs.push([n, v]));
    queryPairs.sort(([a, b], [c, d]) => (a === c ? b.localeCompare(d) : a.localeCompare(c)));
    const canonicalQuery = queryPairs.map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`).join('&');
    // 规则 1：**GET 不带 `Content-Type`**；POST 必须带（且要与签名头集合一致）。
    const contentType = 'application/json;charset=utf8';
    const original = {
        'x-subscription-type': 'v2',
        'X-Sdk-Date': xdate,
        'X-Security-Token': credential.securityToken.trim(),
        Host: u.host,
    };
    if (method === 'POST')
        original['Content-Type'] = contentType;
    if (credential.projectId)
        original['X-Project-ID'] = credential.projectId;
    // R()：签名用**小写名**，值 trim + 折叠空白
    const lower = {};
    for (const [k, v] of Object.entries(original))
        lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
    const signedHeaders = Object.keys(lower).sort();
    // 规则 3：头行 LF 分隔 + 末尾 LF
    let canonicalHeaders = '';
    for (const h of signedHeaders)
        canonicalHeaders += `${h}:${lower[h]}\n`;
    // payload 哈希：**待签body文本**（无 body 时为空串）
    const payloadHash = createHash('sha256').update(body ?? '', 'utf8').digest('hex');
    const canonicalRequest = [
        method, canonicalUri, canonicalQuery, canonicalHeaders,
        signedHeaders.join(';'), payloadHash,
    ].join('\n');
    const scope = `${xdate.slice(0, 8)}/${region}/${service}`;
    const stringToSign = ['V11-HMAC-SHA256', xdate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    // 规则 2：密钥派生
    const u1 = createHmac('sha256', credential.access).update(credential.secret).digest();
    const derivedKey = createHmac('sha256', u1)
        .update(Buffer.concat([Buffer.from(scope, 'utf8'), Buffer.from([1])]))
        .digest()
        .subarray(0, 32)
        .toString('hex');
    const signature = createHmac('sha256', Buffer.from(derivedKey, 'utf8')).update(stringToSign).digest('hex');
    const r = await fetch(url, {
        method,
        headers: {
            ...original,
            Authorization: `V11-HMAC-SHA256 Credential=${credential.access}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
        },
        ...body === undefined ? {} : { body },
        signal: AbortSignal.timeout(30_000),
    });
    if (statusOut !== undefined)
        statusOut.status = r.status;
    /**
     * ⚠️ 失败时**必须把报文读出来**（P1）：返回值对失败恒为空串，
     * 报文是调用方能拿到的**唯一**失败原因。读失败也不能抛（否则吞掉状态码判据），
     * 故 `.catch(() => '')`。
     */
    if (errorBodyOut !== undefined && !r.ok) {
        errorBodyOut.text = await r.text().catch(() => '');
    }
    return r.ok ? await r.text() : '';
}
async function signAndGet(url, credential) {
    return signAndRequest(url, credential, 'GET');
}
/**
 * 云侧订阅直读（V11 签名）—— 余额查询的**主路径**，不依赖 OfficeAce。
 *
 * 端点：`GET {agentarts}/v1/subscription`（`x-subscription-type: v2`）。
 * 响应含套餐桶（`skus[].quotas`，`sku_attr_code === 'officeace_points'`）
 * 与 bonus 桶（`bonus_skus[]`）—— 与果办界面右上角的分桶完全同源
 *（复刻自 OfficeAce `hHe()` 的归一化逻辑）。
 */
/**
 * 云侧直读的**兼容包装**：先按 ref 读凭据，再调 {@link fetchCloudSubscriptionFor}。
 *
 * ⚠️ 多账号调用方应**直接用 `fetchCloudSubscriptionFor(credential)`** 并显式
 *    传入自己那份凭据 —— 由本函数去猜该读哪份，正是串号的来源。
 */
async function fetchCloudSubscription(ref) {
    const credential = readStoredCredential(ref);
    if (credential === undefined)
        return undefined;
    // 无 ref 的单账号兜底路径也自动签到一次（多账号路径在
    // `fetchSubscriptionSummary` 里处理）。ref 缺省时用文件名做去重键。
    await maybeClaimBonus(credential, ref ?? '__default__');
    return fetchCloudSubscriptionFor(credential);
}
/**
 * 用**给定**凭据云侧直读订阅（V11 签名）。
 *
 * ⚠️ 凭据由调用方明确指定，本函数不做任何「该读哪一份」的猜测 ——
 *    多账号下这个猜测必错（实测两个账号都显示第一个账号的余额）。
 */
async function fetchCloudSubscriptionFor(credential) {
    if (!credentialUsable(credential)) {
        return undefined;
    }
    const body = await signAndGet(`${OFFICEACE.defaultBaseUrl.replace(/\/+$/, '')}/v1/subscription`, credential);
    if (body.length === 0)
        return undefined;
    const j = JSON.parse(body);
    const now2 = Date.now();
    const creditGroups = [];
    for (const sku of j.skus ?? []) {
        for (const q of sku.quotas ?? []) {
            if (q.sku_attr_code !== 'officeace_points')
                continue;
            const total = Number(q.sku_value);
            const used = Number(q.current_value);
            const expiredAt = typeof q.expired_time === 'string' && q.expired_time.length > 0 ? q.expired_time : null;
            const isTrial = String(sku.sku_code ?? '').endsWith('.trial');
            creditGroups.push({
                key: `plan-${String(sku.sku_code ?? '')}`,
                name: typeof sku.sku_name === 'string' ? sku.sku_name : '套餐',
                kind: 'plan',
                remaining: Math.max(0, total - used),
                total,
                used,
                expiresAt: isTrial ? undefined : expiredAt ?? undefined,
                expired: !isTrial && expiredAt !== null && new Date(expiredAt).getTime() <= now2,
            });
        }
    }
    for (const bonus of j.bonus_skus ?? []) {
        const points = Number(bonus.points);
        const used = Number(bonus.current_value);
        if (!Number.isFinite(points))
            continue;
        creditGroups.push({
            key: `bonus-${String(bonus.activity_id ?? '')}`,
            name: typeof bonus.activity_name === 'string' ? bonus.activity_name : '活动奖励',
            kind: 'bonus',
            remaining: Math.max(0, points - used),
            total: points,
            used,
            expiresAt: typeof bonus.expired_time === 'string' ? bonus.expired_time : undefined,
            expired: typeof bonus.expired_time === 'string' && new Date(bonus.expired_time).getTime() <= now2,
        });
    }
    if (creditGroups.length === 0)
        return undefined;
    const totalCredits = creditGroups
        .filter((g) => !g.expired)
        .reduce((sum, g) => sum + g.remaining, 0);
    return {
        planName: creditGroups.find((g) => g.kind === 'plan')?.name,
        totalCredits,
        usedCredits: creditGroups.reduce((sum, g) => sum + (g.used ?? 0), 0),
        creditGroups,
    };
}
/**
 * 自动领取每日福利（**签到**）——`POST /v1/subscription/bonus/claim`。
 *
 * ## 为什么需要它（以及为什么必须是**自动**的）
 *
 * OfficeAce 的签到实际上是「每日送 1000 积分」的活动桶（`bonus_skus` 里的
 * `bonus-bonus-daily-checkin-2026`）。果办客户端的做法是**订阅页一挂载就自动
 * 调这个端点**（源码 `SubscriptionStateProvider`：用「年+月+日+时」做去重键，
 * 每小时最多领一次）—— **UI 上没有签到按钮**，不存在「手动签到」这回事。
 *
 * 故插件侧也必须是自动的：拉余额之前顺手领一次。
 *
 * ⚠️ **积分当日作废**（实测 2026-10-13）：`expired_time` 是当天 23:59:59。
 *    当天不领就永久失去那 1000 分 —— 这正是自动领取的价值所在。
 *
 * ⚠️ **失败的错误文本必须带出来**（2026-10-18 真实报障）：原先这里是一个裸
 *    `catch { return [] }`，尽管上一行的注释就写着「记日志而不是静默吞」。
 *    实测后果：凭据过期后**连续三天**每日签到 401 全失败、每天白丢 1000 分，
 *    而日志与面板**一个字都没有** —— 用户只能从「临期桶不见了」反推。
 *    ⇒ 本函数改为返回**结果对象**：调用方据此决定记日志与是否重试。
 *
 * @returns 领取结果。`ok: true` 时为领到的活动桶；`ok: false` 时带错误原因
 *（**不抛错**：签到失败绝不阻断余额展示）。
 */
export async function claimDailyBonus(credential) {
    if (!credentialUsable(credential)) {
        return { ok: false, reason: '凭据缺失（access 或 securityToken 缺失或为空），未发起签到请求' };
    }
    try {
        // ⚠️ **POST 必须带 `Content-Type`**（规则 1 的另一面）：实测不带会得到
        //    HTTP 500 `OfficeAce.11020001 内部服务器错误`；带了才是 200。
        //    body 为空即可 —— 该端点不需要入参（果办也是 `void 0`）。
        const statusOut = { status: 0 };
        const errorBodyOut = { text: '' };
        const body = await signAndRequest(`${OFFICEACE.defaultBaseUrl.replace(/\/+$/, '')}/v1/subscription/bonus/claim`, credential, 'POST', undefined, statusOut, errorBodyOut);
        // ⚠️⚠️ **非 2xx 必须显式判状态码**（2026-10-18）：`signAndRequest` 对失败
        //    与「空响应体」都返回空串 ⇒ 401 会被读成「今天没有可领的」，于是每天
        //    白丢 1000 分且日志无痕。这里按状态码如实报失败。
        //
        // ⚠️⚠️ **失败原因必须带出服务端报文**（P1）：`body` 在非 2xx 时恒为空串，
        //    拿它拼 reason 只会得到 `HTTP 401：` —— 而报文往往是**唯一指路信息**
        //    （`token expired` / `IAM.0011` / 签名过期），丢了就退回「无从处置」。
        if (!Number.isFinite(statusOut.status) || statusOut.status < 200 || statusOut.status >= 300) {
            const detail = errorBodyOut.text.trim().slice(0, 200);
            return {
                ok: false,
                reason: `HTTP ${statusOut.status === 0 ? '（未发出/无响应）' : statusOut.status}${detail === '' ? '' : `：${detail}`}`,
            };
        }
        if (body.length === 0)
            return { ok: true, skus: [] };
        const j = JSON.parse(body);
        return {
            ok: true,
            skus: (j.bonus_skus ?? []).map((s) => ({
                activityId: String(s.activity_id ?? ''),
                activityName: typeof s.activity_name === 'string' ? s.activity_name : '活动奖励',
                points: Number(s.points) || 0,
            })),
        };
    }
    catch (error) {
        // ⚠️ 签到失败**绝不阻断**余额查询，但**必须留痕**（仓库约定：不允许静默吞）。
        return {
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}
/**
 * 「够了就不要再领」的节流：同一 ref **每小时最多领一次**（与果办客户端同款
 * 去重键：年+月+日+时）。
 *
 * ⚠️ 不去重的后果：余额每次刷新都打一次 claim ⇒ 面板每开一次就多发一个
 *    请求，且服务端若对重复领取返回异常，日志会被刷屏。
 * ⚠️ 按 ref 而非全局：多账号下每个账号**各自**都要领，共用一把锁会让
 *    第二个账号永远领不到（它的签到分当日作废）。
 *
 * ⚠️⚠️ **失败必须撤销占坑**（2026-10-18 真实报障）：原实现是「先 `set` 占坑、
 *    再领取」，且 `.catch(() => [])` —— 于是**失败那一次也把这一小时钉死了**。
 *    实测形态：登录是**异步**写凭据库的，面板刷新与 `login.poll` 会赛跑；
 *    若刷新抢在落盘之前拿到旧/空凭据 ⇒ 401 ⇒ 静默失败 ⇒ 该小时内后续所有
 *    刷新**全部跳过、不再重试**，直到下一小时才可能领到 —— 而当日积分
 *    23:59:59 作废，一次钉死就可能是当天 1000 分的永久损失。
 *
 *    ⇒ 失败时**撤销**占位，让下一次刷新重试。服务端对重复领取幂等
 *    （「每日签到有礼」一天只有一份），重试无害。
 *
 * ⚠️⚠️ **撤销必须与 `.catch()` 兜底成对出现**（2026-10-18 审计实测的 P0）：
 *    原实现是 `.then(...)` 而**没有** `.catch` —— 而 `claimDailyBonus` 确实会
 *    reject（凭据字段缺失时的前置判断抛错）。那条 rejection 路径
 *    **既进不了 `result.ok` 分支、也拿不到 `.catch(() => [])` 的兜底**，
 *    异常一路冒到调用方的空 `catch` ⇒ 零留痕 + 余额查询一并被跳过。
 *    ⇒ 拒绝路径必须与失败路径**同等对待**：撤销占坑 + 留痕。
 *
 * ⚠️ **占坑撤销必须按 hourKey 条件删**（P3）：`hourKey` 在**进入时**算，
 *    而响应回来时可能已跨整点。若那时新一轮刷新已用**新** hourKey 重建了占坑，
 *    无条件 `delete(ref)` 会把**别人的**占坑删掉 ⇒ 节流失效（多打一次请求）。
 *    形态轻（多打的仍是幂等签到），但白搭一次往返与一条 warn。
 */
const lastClaimAt = new Map();
function maybeClaimBonus(credential, ref) {
    const now = new Date();
    const hourKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (lastClaimAt.get(ref) === hourKey)
        return Promise.resolve([]);
    lastClaimAt.set(ref, hourKey);
    /**
     * ⚠️ **撤销占坑只删「自己那一格」**（P3，跨整点时别删掉新一轮的占坑）。
     */
    const releaseSlot = () => {
        if (lastClaimAt.get(ref) === hourKey)
            lastClaimAt.delete(ref);
    };
    return claimDailyBonus(credential).then((result) => {
        if (result.ok)
            return result.skus;
        releaseSlot();
        console.warn(`[officeace] 每日签到失败（ref=${ref}）：${result.reason}`);
        return [];
    }).catch((error) => {
        /**
         * ⚠️⚠️ **拒绝路径与失败路径同等对待**（P0，见上方长注释）。
         * 少了这一条：reject 既不留痕、也不撤销占坑 ⇒ 该小时仍被钉死，
         * 且异常被调用方的空 `catch` 静默吞掉 ⇒ 零留痕 + 余额查询被跳过。
         */
        releaseSlot();
        console.warn(`[officeace] 每日签到异常（ref=${ref}）：${error instanceof Error ? error.message : String(error)}`);
        return [];
    });
}
/** Basic 授权头值（推理用）。 */
export function basicAuthorization(credential) {
    return 'Basic ' + Buffer.from(`${credential.modelAppKey}:${credential.modelAppSecret}`).toString('base64');
}
/** 读凭据并顺带判断 STS 是否临期（调用方决定是否先刷新）。 */
export function isExpiring(credential, leadMs = 10 * 60 * 1000) {
    const exp = Date.parse(credential.expiresAt);
    if (!Number.isFinite(exp))
        return true;
    return exp - Date.now() < leadMs;
}
/** 探测凭据可读（面板/目录门控用）。 */
export async function probeOfficeAce() {
    try {
        return readStoredCredential() !== undefined;
    }
    catch {
        return false;
    }
}
// ────────────────────────── 兼容旧调用方（jet-hub-rpc）──────────────────────────
/**
 * 读凭据：优先 DSH 自有存储；OfficeAce 客户端已装且登录过时**回读迁移**。
 *
 * ⚠️ 迁移是**一次性的桥**：OfficeAce Redis 里的凭据结构与 DSH 自有登录不同
 *（缺 DPoP 私钥 ⇒ 不能刷新），故迁移条目标记 refresh 能力降级 —— 面板会提示
 * 重新登录一次以获得完整能力。
 */
export async function readOfficeAceCredential() {
    const own = readStoredCredential();
    if (own !== undefined)
        return own;
    // 回读 OfficeAce Redis（兼容：装过客户端的用户零成本迁移推理能力）
    return readFromOfficeAceRedis();
}
function credRead(target) {
    const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OC_CM {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string t, int ty, int f, out IntPtr p);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
}
'@
$ptr=[IntPtr]::Zero
if(-not [OC_CM]::CredRead('${target.replace(/'/g, "''")}',1,0,[ref]$ptr)){ Write-Output 'OC_NX'; exit }
$c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][OC_CM+CREDENTIAL])
$b=New-Object byte[] $c.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize)
[OC_CM]::CredFree($ptr)|Out-Null
Write-Output ('OC_U16[' + [Text.Encoding]::Unicode.GetString($b) + ']OC_ASC[x]')
`;
    return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000 }, (err, stdout) => {
            if (err) {
                resolve(undefined);
                return;
            }
            const text = String(stdout);
            if (!text.includes('OC_U16[')) {
                resolve(undefined);
                return;
            }
            resolve({ utf16: text.slice(text.indexOf('OC_U16[') + 7, text.indexOf(']OC_ASC[')), ascii: '' });
        });
    });
}
function enc(args) {
    let out = `*${args.length}\r\n`;
    for (const a of args)
        out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
    return out;
}
function redisExec(port, commands, timeoutMs) {
    return new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1');
        let buf = '';
        let settled = false;
        const done = () => {
            if (settled)
                return;
            settled = true;
            try {
                sock.destroy();
            }
            catch { /* 已关 */ }
            resolve(buf);
        };
        const expect = commands.length;
        const countTopLevel = () => {
            let count = 0;
            for (const line of buf.split('\r\n')) {
                if (/^[+\-:$*]/.test(line))
                    count++;
            }
            return count;
        };
        sock.on('data', (c) => {
            buf += c.toString('utf8');
            if (countTopLevel() >= expect)
                done();
        });
        sock.setTimeout(timeoutMs, done);
        sock.on('error', done);
        let payload = '';
        for (const cmd of commands)
            payload += enc(cmd);
        sock.write(payload);
    });
}
function respFirst(reply) {
    for (const line of reply.split('\r\n')) {
        if (line.startsWith('$') && line !== '$-1') {
            const idx = reply.split('\r\n').indexOf(line);
            return reply.split('\r\n')[idx + 1];
        }
    }
    return undefined;
}
/** OfficeAce Redis 回读（迁移桥，主路径是 readStoredCredential）。 */
async function readFromOfficeAceRedis() {
    try {
        const pw = await credRead('OfficeClaw/redis/password');
        if (pw === undefined)
            return undefined;
        const password = pw.utf16.trim();
        if (password.length === 0)
            return undefined;
        const keysReply = await redisExec(6399, [['AUTH', password], ['KEYS', 'office-claw:oc:session:user:*']], 8_000);
        if (!keysReply.includes('+OK'))
            return undefined;
        const lines = keysReply.split('\r\n');
        const keyLines = [];
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].startsWith('$') && lines[i] !== '$-1')
                keyLines.push(lines[i + 1]);
        }
        const sessionKey = keyLines.find((k) => k && !k.startsWith('+'));
        if (sessionKey === undefined)
            return undefined;
        const valueReply = await redisExec(6399, [['AUTH', password], ['GET', sessionKey]], 8_000);
        const json = respFirst(valueReply);
        if (json === undefined)
            return undefined;
        const parsed = JSON.parse(json);
        const auth = parsed?.providerState?.modelInfo?.model_auth_info;
        const appKey = auth?.model_app_key;
        const appSecret = auth?.model_app_secret;
        if (typeof appKey !== 'string' || typeof appSecret !== 'string' || appKey.length === 0)
            return undefined;
        const baseUrl = parsed?.providerState?.modelInfo?.model_api_url_base;
        return {
            modelAppKey: appKey,
            modelAppSecret: appSecret,
            maasBaseUrl: typeof baseUrl === 'string' && baseUrl.length > 0 ? `https://${baseUrl}` : OFFICEACE.defaultBaseUrl,
            access: '', secret: '', securityToken: '', projectId: '', expiresAt: '',
            refreshToken: '',
            dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: '', y: '' },
            displayName: typeof parsed.displayName === 'string' ? parsed.displayName : undefined,
        };
    }
    catch {
        return undefined;
    }
}
/** Redis 密码的凭据管理器目标名（诊断日志用）。 */
export const REDIS_CRED_TARGET = 'OfficeClaw/redis/password';
export { OFFICEACE };
//# sourceMappingURL=officeace-auth.js.map