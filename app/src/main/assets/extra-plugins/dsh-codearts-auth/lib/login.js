import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getRandomValues, randomUUID, randomBytes } from 'node:crypto';
import { CLIENT_ID, REDIRECT_PATH, credentialFromTokenResponse, exchangeAuthorizationCode, generateDpopKeyPair, generatePkcePair, } from './oauth.js';
export const CODEARTS_LOGIN_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect';
export const HUAWEI_AUTH_BASE = 'https://auth.huaweicloud.com/authui/login.html';
export const CREDENTIAL_ENDPOINT = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket';
const PLUGIN_NAME = 'snap_jetbrains';
const PLUGIN_VERSION = '26.3.3';
/** 与重定向流程共享的随机 64 字符小写十六进制密钥。 */
export function generateRandomSecret() {
    const bytes = getRandomValues(new Uint8Array(32));
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** 构建 doer/redirect URL 及包裹它的华为认证页面 URL。 */
export function buildLoginUrl(port, ticketId) {
    const callbackUrl = `http://127.0.0.1:${port}/authentication`;
    const redirectUrl = `${CODEARTS_LOGIN_BASE}?IdeaType=jetbrains&auth_callback_url=${encodeURIComponent(callbackUrl)}&plugin-name=${PLUGIN_NAME}&plugin-version=${PLUGIN_VERSION}&ticket_id=${encodeURIComponent(ticketId)}`;
    const loginUrl = `${HUAWEI_AUTH_BASE}?service=${encodeURIComponent(redirectUrl)}`;
    return { redirectUrl, loginUrl };
}
/** 将一次 ticket 响应归一化为凭据，未完成时返回 null。 */
export function parseCredentialResponse(data) {
    if (data.credential) {
        const access = data.credential.access ?? '';
        const st = data.credential.securitytoken ?? data.credential.securityToken ?? '';
        if (access && st) {
            return {
                access_key_id: access,
                secret_access_key: data.credential.secret ?? '',
                security_token: st,
                expires_at: data.credential.expires_at ?? data.credential.expiresAt ?? '',
                domain_id: data.domain_id ?? '',
                user_id: data.user_id ?? '',
                user_name: data.user_name ?? '',
            };
        }
    }
    if (data.result) {
        const ak = data.result.accessKeyId ?? '';
        const st = data.result.securityToken ?? '';
        if (ak && st) {
            return {
                access_key_id: ak,
                secret_access_key: data.result.secretAccessKey ?? '',
                security_token: st,
                expires_at: data.result.expiration ?? data.result.expiresAt ?? '',
            };
        }
    }
    return null;
}
/** 凭据的过期时间戳（毫秒）；时间戳无法解析时回退为 +24 小时。 */
export function expiresFromCredential(credential) {
    if (credential.expires_at) {
        const parsed = Date.parse(credential.expires_at);
        if (!Number.isNaN(parsed))
            return parsed;
    }
    return Date.now() + 86_400_000;
}
/**
 * 轮询 ticket 端点，直到收到完整凭据或尝试
 * 次数耗尽。瞬时失败会被跳过，不会视为致命错误。
 */
export async function pollForCredential(ticketId, secret, options = {}) {
    const fetcher = options.fetcher ?? fetch;
    const maxAttempts = options.maxAttempts ?? 120;
    const pluginName = options.pluginName ?? PLUGIN_NAME;
    const pluginVersion = options.pluginVersion ?? PLUGIN_VERSION;
    const url = `${CREDENTIAL_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`;
    for (let i = 0; i < maxAttempts; i++) {
        if (i > 0)
            await new Promise((resolve) => setTimeout(resolve, 1000));
        let response;
        try {
            response = await fetcher(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json;charset=UTF-8',
                    'plugin-name': pluginName,
                    'plugin-version': pluginVersion,
                },
            });
        }
        catch {
            continue;
        }
        if (!response.ok)
            continue;
        let data;
        try {
            data = (await response.json());
        }
        catch {
            continue;
        }
        const credential = data ? parseCredentialResponse(data) : null;
        if (credential)
            return credential;
    }
    throw new Error('CodeArts login timed out');
}
/**
 * 使用平台默认打开器打开 URL；永不抛出异常。
 *
 * ⚠️ **「永不抛出」必须靠 `'error'` 监听器兑现**（真实缺陷，2026-10-03）。
 *
 * `spawn` 的失败（`ENOENT` / `EACCES`）是以**异步 `'error'` 事件**上报的，
 * 外层 `try/catch` **接不住**它。而 `ChildProcess` 是 EventEmitter ——
 * `'error'` 没有监听器时会被 `throw` 成**未捕获异常**。
 *
 * POSIX 上这很容易踩：无桌面环境的 `open`（macOS）/ `xdg-open`（Linux）
 * 常常不存在 ⇒ `ENOENT` ⇒ **直接把宿主进程带走**。
 * （Windows 的 `cmd` 恒存在，所以只在 POSIX 上暴露 —— 典型的「本地测不出来」。）
 *
 * ⚠️ 用 `child.unref()` + 监听器，不能只 `unref` 就完事：前者让父进程
 * 不因它挂起，后者补上缺失的监听器，二者缺一不可。
 */
export function openBrowser(url) {
    const warn = (error) => {
        console.error('[codearts-auth] failed to open browser; open manually:', url, error);
    };
    const win = process.platform === 'win32';
    if (win) {
        // Windows 下 cmd /c start 会把 URL 中每个 '&' 当作命令分隔符，导致参数被截断
        // （浏览器只收到 '?theme=2'）。必须把整个 URL 加引号作为单个参数传给 cmd，
        // 并用 windowsVerbatimArguments 关闭 Node 的二次转义。start 的窗口标题参数
        // 必须显式传 '""'——空字符串参数会被 Node 丢弃，start 会把 URL 当成标题。
        const args = ['/c', 'start', '""', `"${url}"`];
        try {
            const child = spawn('cmd', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
            child.on('error', warn);
            child.unref();
            return;
        }
        catch (error) {
            warn(error);
            return;
        }
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
        const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
        child.on('error', warn);
        child.unref();
    }
    catch (error) {
        warn(error);
    }
}
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
};
/**
 * 从 Windows 注册表取默认浏览器的可执行文件路径与参数模板。
 *
 * ## 为什么需要它（而不是直接用 `openBrowser`）
 *
 * `cmd /c start` 只能把 URL 交给系统默认打开器，**无法附加 `--incognito`**；
 * 而 `window.open` 在客户端也无法请求无痕模式（该标志是进程级启动参数、
 * 不是 JS 能控制的窗口特性）。
 *
 * 故要走无痕只能在宿主侧**直接拉起浏览器可执行文件**，而它的路径只有注册表
 * 这个真相源（用户装的可能是 Chrome / Edge / 360 / Firefox，路径各不相同，
 * 不能硬编码）。读 `UrlAssociations\https\UserChoice` 拿 ProgId，再读该
 * ProgId 的 `shell\open\command`。
 *
 * @returns 可执行文件路径；读不到时 `undefined`（调用方回退到 `openBrowser`）。
 */
function defaultBrowserExecutable() {
    if (process.platform !== 'win32')
        return undefined;
    // ⚠️ 只用 `reg.exe` 而不引第三方依赖：注册表读取是本功能唯一的平台相关调用，
    //    为它加一个 native 依赖不划算（且本插件的 peer 约束不允许）。
    const query = (key, value) => {
        try {
            const out = execFileSync('reg', ['query', key, '/v', value], {
                encoding: 'utf8', timeout: 5000, windowsHide: true,
            });
            // 形如：`    ProgId    REG_SZ    360ChromeXURL`
            const m = /REG_SZ\s+(.+?)\s*$/m.exec(out);
            return m?.[1]?.trim();
        }
        catch {
            return undefined;
        }
    };
    const progId = query('HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId');
    if (progId === undefined || progId.length === 0)
        return undefined;
    // ⚠️ 三个位置都要试：`UserChoice` 的 ProgId 可能只注册在 HKCR（合并视图）
    //    或 HKCU\Software\Classes（用户级安装，本机 360 就是这种）。
    for (const root of [
        `HKCR\\${progId}\\shell\\open\\command`,
        `HKCU\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`,
        `HKLM\\SOFTWARE\\Classes\\${progId}\\shell\\open\\command`,
    ]) {
        try {
            const out = execFileSync('reg', ['query', root, '/ve'], {
                encoding: 'utf8', timeout: 5000, windowsHide: true,
            });
            // 形如：`    (Default)    REG_SZ    "C:\...\360ChromeX.exe" -- "%1"`
            const m = /REG_SZ\s+(.+?)\s*$/m.exec(out);
            const raw = m?.[1];
            if (raw === undefined)
                continue;
            // 取命令行里的**第一个**被引号包裹的路径；没有引号则取到第一个空格前。
            const quoted = /^"([^"]+)"/.exec(raw);
            const exe = quoted?.[1] ?? raw.split(' ')[0];
            if (exe !== undefined && exe.length > 0 && existsSync(exe))
                return exe;
        }
        catch { /* 试下一个位置 */ }
    }
    return undefined;
}
/**
 * 用**无痕窗口**打开 URL（华为云 OAuth 换账号登录用）。
 *
 * ## 为什么必须无痕（实测依据，2026-10-13）
 *
 * 华为 `authui` 会**静默复用**浏览器已有的登录会话：带着已登录 cookie 打开
 * 授权页会直接放行，**看不到登录框**，于是「新建账号」永远只能建出同一个号。
 * 实测三条：
 *
 * | 试验 | 结果 |
 * |---|---|
 * | `authui/login.html?service=<authorize>` | 200 直接返回页面（复用会话）|
 * | authorize 追加 `&prompt=login` | **仍 200，无重定向** ⇒ authui 忽略该参数 |
 * | `authui/logout?service=<authorize>` | 302 先清会话再跳 authorize |
 *
 * ⇒ 只有两条路：先 logout，或换一个 cookie jar。**选后者**：
 * `logout` 的作用域是整个 `auth.huaweicloud.com` 域（实测 `Set-Cookie` 含
 * `cloud_verify_ticket` 清除与 `IAMIdentity` 重写），会**连带登出用户日常浏览器
 * 里的华为云控制台**；无痕窗口则是全新 cookie jar，天然无会话，
 * **既不碰用户既有会话、也不需要 logout**。
 *
 * ⚠️ 官方客户端（果办）也没有解决这点：它的 `LoginPage` 用
 * `window.open(url, 'officeclaw-login', 'popup,…')` 开共享 cookie 的小窗，
 * 「重新登录」则走 `authui/logout`（`LoginCallbackPage`）。即官方同样无法
 * 换账号登录 —— 别把它当参考实现。
 *
 * @returns 是否成功以无痕方式拉起（`false` 时调用方应回退到普通打开）。
 */
export function openIncognitoWindow(url) {
    // ⚠️⚠️ **测试环境断路器**（2026-10-13，我自己踩出来的真实污染）。
    //
    // 本函数**会真的 spawn 浏览器**。而 `officeace-rpc-multi-account.spec.ts`
    // 之类的用例会走**真实的 `account.create` RPC**，其桩数据里带着
    // `authorizeUrl: 'https://auth.huaweicloud.com/stub'` ⇒ 每跑一次 `pnpm test`
    // 就在用户桌面上弹一个 `auth.huaweicloud.com/stub` 窗口。
    //
    // ⇒ 判据用 `NODE_ENV === 'test'`（Vitest 会设）。**返回 `false` 而不是抛错**：
    // 调用方据此走正常的「回退到 window.open」分支，断言形态与生产一致，
    // 唯一的差别是不真开窗 —— 这正是单测想要的。
    //
    // ⚠️ 不要改成「检测到 stub URL 就跳过」：那是**按数据打补丁**，
    // 下一个用例换个 URL 就会复发。必须按**运行环境**一刀切断。
    if (process.env.NODE_ENV === 'test')
        return false;
    const exe = defaultBrowserExecutable();
    if (exe === undefined)
        return false;
    // ⚠️⚠️ **不要用「app 模式」开关**（2026-10-13 真机实测证伪，阻断级）。
    //
    // 初版传了「app 模式」+ URL，想让窗口去掉地址栏、视觉上更像个授权小窗。
    // 在 360 极速浏览器 X（本机默认浏览器）上实测：窗口开了，但页面显示
    //   「域名解析错误 —— 请检查域名拼写，可用"360断网急救箱"检查网络」
    // 即它把该开关后面的值当成**域名/搜索词**去解析了，而不是当成 URL。
    //
    // 隔离探针（本地 HTTP 服务器 + 独立 `--user-data-dir`）显示该开关本身
    // 能被 Chromium 正确解析并发出请求 ⇒ 这是**该浏览器对它的改写/拦截**，
    // 不是我们的 URL 编码问题（实测 28 个 `%` 序列逐字送达服务器）。
    //
    // ⇒ 结论：**换取账号这个核心目的不依赖「app 模式」**，而它带来的失败是
    // 阻断级（用户看到的是一个错误页，根本无法登录）。故只用无痕开关，
    // 窗口形态交给浏览器（有地址栏，但功能完全正确）。
    //
    // ⚠️ 无痕开关是 Chromium 家族的通用参数（Chrome / Edge / 360 / Brave /
    //    Vivaldi 等）。Firefox 用 `-private-window` 且不认它，故走下面的分支。
    const isFirefox = /firefox\.exe$/i.test(exe);
    const args = isFirefox
        ? ['-private-window', url]
        : ['--incognito', '--new-window', url];
    try {
        const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
        // ⚠️ 必须挂 'error' 监听器 + unref：理由见 `openBrowser` 的长注释
        //    （spawn 的失败是异步 'error' 事件，外层 try/catch 接不住，
        //    无监听器时会变成未捕获异常把宿主带走）。
        child.on('error', (error) => {
            console.error('[codearts-auth] failed to open incognito window:', error);
        });
        child.unref();
        return true;
    }
    catch (error) {
        console.error('[codearts-auth] failed to open incognito window:', error);
        return false;
    }
}
function pickToken(params) {
    return params.get('token')
        ?? params.get('access_token')
        ?? params.get('accessToken')
        ?? params.get('authCode')
        ?? '';
}
/** 浏览器重定向的本地回调服务器；当某个分支完成时 resolve `result`。 */
export function startCallbackServer(ticketId, secret, options) {
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`);
        if (url.pathname !== '/authentication' && !url.pathname.startsWith('/authentication')) {
            response.writeHead(404).end('Not found');
            return;
        }
        if (request.method === 'OPTIONS') {
            response.writeHead(204, CORS_HEADERS).end();
            return;
        }
        const params = url.searchParams;
        const directToken = pickToken(params);
        if (directToken) {
            response.writeHead(200, CORS_HEADERS).end();
            resolveResult({ access: directToken, expires: Date.now() + 86_400_000, loginUrl: '' });
            return;
        }
        const fingerprint = params.get('fingerprint');
        if (fingerprint) {
            try {
                const decoded = Buffer.from(fingerprint, 'base64').toString();
                const fpToken = pickToken(new URL(decoded).searchParams);
                if (fpToken) {
                    response.writeHead(200, CORS_HEADERS).end();
                    resolveResult({ access: fpToken, expires: Date.now() + 86_400_000, loginUrl: '' });
                    return;
                }
            }
            catch {
                /* fingerprint 格式错误：继续到 400 */
            }
        }
        const callbackSecret = params.get('secret');
        if (callbackSecret) {
            response.writeHead(200, CORS_HEADERS).end();
            void pollForCredential(ticketId, callbackSecret, options).then((credential) => resolveResult({
                access: JSON.stringify(credential),
                expires: expiresFromCredential(credential),
                loginUrl: '',
            }), (error) => rejectResult(error));
            return;
        }
        response.writeHead(400).end('Missing token or secret');
    });
    return new Promise((resolveStart, rejectStart) => {
        server.on('error', (error) => rejectStart(error));
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            resolveStart({ port, server, result });
        });
    });
}
/** 运行完整的浏览器登录流程，返回已存储的凭据值。 */
export async function runLoginFlow(options = {}) {
    const ticketId = randomUUID();
    const secret = generateRandomSecret();
    const { port, server, result } = await startCallbackServer(ticketId, secret, options);
    const { loginUrl } = buildLoginUrl(port, ticketId);
    try {
        const opener = options.openBrowser ?? openBrowser;
        await opener(loginUrl);
        const outcome = await result;
        return { ...outcome, loginUrl };
    }
    finally {
        await new Promise((resolve) => server.close(resolve));
    }
}
/** 新式 IAM OAuth 的 portal 授权端点（对齐真实插件的 getPortalHost + /authorize）。 */
export const PORTAL_AUTHORIZE_BASE = 'https://codearts.huaweicloud.com/portal/authorize';
/** portal 登录结果页（登录完成后重定向目标，对齐真实插件回调处理器的 login_succeed 页）。 */
export const PORTAL_LOGIN_BASE = 'https://codearts.huaweicloud.com/portal/login';
/** 构建 portal 登录结果页 URL（真实插件在回调成功后 307 重定向到此页）。 */
export function buildPortalLoginResultUrl(succeeded) {
    return `${PORTAL_LOGIN_BASE}?login_succeed=${succeeded}&uri_scheme=${CLIENT_ID}&locale=${OAUTH_LOCALE}`;
}
/** portal 期望的插件名（逆向常量，硬编码）。 */
export const LOGIN_PLUGIN_NAME = 'snap_AIIDE';
/** portal 期望的插件版本（逆向常量，硬编码为真实扩展版本，勿用本包版本）。 */
export const LOGIN_PLUGIN_VERSION = '5.2.0';
/** 主题色 kind（对齐 IDE 的 activeColorTheme.kind：2 = Dark）。 */
export const OAUTH_THEME = '2';
/** 界面语言（对齐 env.language）。 */
export const OAUTH_LOCALE = 'zh-cn';
/** 构建新式 IAM OAuth 的 portal 授权 URL（参数完全对齐真实插件 buildLoginUrl）。 */
export function buildOAuthLoginUrl(port, pkce, ticketId) {
    return `${PORTAL_AUTHORIZE_BASE}?theme=${OAUTH_THEME}&locale=${OAUTH_LOCALE}`
        + `&uri_scheme=${CLIENT_ID}&client_id=${CLIENT_ID}&port=${port}`
        // code_challenge_method 对齐真实插件 PKCEGenerator.CODE_CHALLENGE_METHOD = "SHA-256"
        // （非 RFC 标准缩写 S256；portal 以此识别 OAuth 授权，错值会回退旧 ticket 流程）。
        + `&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256`
        // 注意：真实插件 URL 不含 auth_callback_url——portal 仅凭 port 参数构造回调。
        // 多余的 auth_callback_url 会被 portal 视为异常并回退旧流程，切勿添加。
        + `&ticket_id=${ticketId}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`;
}
/** 新式 OAuth 的本地回调服务器：收到 code（新流程）或 secret（旧流程回退）后换取凭据并 resolve。 */
export function startOAuthCallbackServer(ticketId, pkce, keyPair, options) {
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`);
        if (url.pathname !== REDIRECT_PATH && !url.pathname.startsWith(REDIRECT_PATH)) {
            response.writeHead(404).end('Not found');
            return;
        }
        if (request.method === 'OPTIONS') {
            response.writeHead(204, CORS_HEADERS).end();
            return;
        }
        // 旧流程回退：portal 判定 OAuth 授权不可用时以 secret+redirect 回调。
        // 对齐真实插件：立即 307 重定向到 redirect 参数，后台轮询 ticket 端点换取凭据。
        const callbackSecret = url.searchParams.get('secret');
        if (callbackSecret) {
            const redirectTo = url.searchParams.get('redirect') ?? buildPortalLoginResultUrl(true);
            response.writeHead(307, { ...CORS_HEADERS, Location: redirectTo }).end();
            void pollForCredential(ticketId, callbackSecret, {
                ...options,
                pluginName: LOGIN_PLUGIN_NAME,
                pluginVersion: LOGIN_PLUGIN_VERSION,
            }).then((credential) => resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: '' }), (error) => rejectResult(error));
            return;
        }
        const code = url.searchParams.get('code');
        if (code) {
            // localPort 在监听中的服务器上必然存在；?? 0 仅用于类型收窄。
            void exchangeAuthorizationCode(code, pkce.codeVerifier, request.socket.localPort ?? 0, keyPair, options.fetcher).then((token) => {
                const credential = credentialFromTokenResponse(token, pkce, keyPair);
                // 对齐真实插件：换取成功后 307 重定向浏览器到 portal 登录结果页。
                response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(true) }).end();
                resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: '' });
            }, (error) => {
                response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(false) }).end();
                rejectResult(error);
            });
            return;
        }
        response.writeHead(400).end('Missing authorization code or secret');
    });
    return listenOnCallbackPort(server).then((port) => ({ port, server, result }));
}
/** 新式 OAuth 回调等待预算（浏览器打开 + 用户操作，180 秒）。 */
const OAUTH_CALLBACK_TIMEOUT_MS = 180_000;
/** 回调端口下限（对齐真实插件对回调端口的 ≥10000 要求）。 */
const MIN_CALLBACK_PORT = 10_000;
/** 启动回调服务器并确保监听端口 ≥10000（真实插件要求，低端口会被 portal 拒绝）。 */
function listenOnCallbackPort(server) {
    return new Promise((resolve, reject) => {
        const tryListen = (port) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                const address = server.address();
                const assigned = typeof address === 'object' && address ? address.port : 0;
                if (assigned >= MIN_CALLBACK_PORT) {
                    resolve(assigned);
                    return;
                }
                // 端口 < 10000：关闭后用随机 [10000, 65535] 端口重试（对齐真实插件）。
                server.close(() => {
                    const retry = Math.floor(Math.random() * (65_536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT;
                    tryListen(retry);
                });
            });
        };
        tryListen(0);
    });
}
/**
 * 启动 OAuth 登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * `result` 已内置超时：两步式路径没有外层 try/finally 兜底，
 * 若超时不在此处生效，回调服务器会一直挂着。
 * 结果一旦落定就自动关闭服务器，避免两步式路径泄漏监听端口。
 */
export async function startOAuthFlow(options = {}) {
    const ticketId = randomBytes(32).toString('hex');
    const pkce = generatePkcePair();
    const keyPair = await generateDpopKeyPair();
    const { port, server, result } = await startOAuthCallbackServer(ticketId, pkce, keyPair, options);
    const loginUrl = buildOAuthLoginUrl(port, pkce, ticketId);
    let closed = false;
    const close = async () => {
        if (closed)
            return;
        closed = true;
        await new Promise((resolve) => server.close(() => resolve()));
    };
    const resultWithUrl = Promise.race([
        result,
        new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('CodeArts OAuth login timed out')), OAUTH_CALLBACK_TIMEOUT_MS);
            timer.unref?.();
        }),
    ]).then((outcome) => ({ ...outcome, loginUrl }));
    // 先挂一个空处理器：结果可能在调用方 await 之前就落定（用户授权极快、
    // 或立刻超时），那一段窗口里 Node 会把它当成未处理拒绝并打印告警。
    resultWithUrl.catch(() => { }).finally(() => { void close(); });
    return { loginUrl, result: resultWithUrl, close };
}
/**
 * 运行完整的新式 IAM OAuth 登录流程（默认登录方式）。
 *
 * 阻塞语义：打开浏览器并等待用户完成授权后才返回。
 * 需要「立即拿到 URL」的场景（Jet Hub 两步式登录）请用 {@link startOAuthFlow}。
 */
export async function runOAuthFlow(options = {}) {
    const started = await startOAuthFlow(options);
    try {
        const opener = options.openBrowser ?? openBrowser;
        await opener(started.loginUrl);
        return await started.result;
    }
    finally {
        await started.close();
    }
}
//# sourceMappingURL=login.js.map