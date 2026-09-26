/**
 * LobsterAI（有道龙虾）登录：本地回调服务器 + `authCode` 换 token。
 *
 * ## 与 `lobsterai2api` 的实现差异（有意为之）
 *
 * Go 侧是**两个进程 + 一个 `/tmp` 状态文件**：
 * `login.exe url` 起回调服务器后把 `{port,state,uuid,firstKeyfrom}` 落盘到
 * `/tmp/lb2api-login-state.json`，阻塞等待 `.result` 文件出现；
 * `login.exe poll` 再读那个文件取结果（由 `login.sh` 顺序驱动，
 * 中间还夹一个 `read -rp "按 y 继续"` 的人在环确认）。
 *
 * 本模块把这套编排**收进单个进程内的 Promise**：
 * 回调服务器收到 `code` 后**立即在本进程完成 exchange**，
 * 直接 `resolve` 结果。这样就没有跨进程状态文件、没有残留文件误判、
 * 没有 shell 与 python3 依赖 —— 而这三样正是 Go 侧最脆弱的环节
 * （`main.go:162-164` 专门写了清理上一轮残留的代码，就说明它踩过坑）。
 *
 * 骨架取自 `src/login.ts` 的 CodeArts OAuth 回调服务器（本插件已验证的模式），
 * 但没有 PKCE / DPoP —— LobsterAI 的 exchange 不要求它们。
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { LOBSTERAI_CALLBACK_PATH, LOBSTERAI_EXCHANGE_PATH, LOBSTERAI_LOGIN_TIMEOUT_MS, LOBSTERAI_REQUEST_TIMEOUT_MS, isLobsteraiRefreshable, lobsteraiCredentialExpiresAtMs, lobsteraiAnonymousHeaders, parseLobsteraiEnvelope, parseLobsteraiTokenPayload, buildLobsteraiCredential, } from './lobsterai.js';
/** 生成一次性登录会话（uuid + firstKeyfrom）。 */
export function createLobsteraiLoginSession(nowMs = Date.now()) {
    return { uuid: randomUUID(), firstKeyfrom: String(nowMs) };
}
/**
 * 构造 portal 登录 URL。
 *
 * 形态照抄 `main.go:225-228`：
 * `{portal}/portal#/login?source=electron&redirect_uri=...&state=...`
 *
 * 三个 query 参数的语义：
 * - `source=electron` —— 声明登录来源是桌面客户端（portal 据此选择交互流程）；
 * - `redirect_uri` —— **必须**是 `http://127.0.0.1:{port}/auth/callback` 形态，
 *   登录页会校验（`main.go:223-225` 的注释明确记录了这一约束）；
 * - `state` —— 防 CSRF 的一次性随机串，回调时原样带回并比对。
 *
 * ⚠️ 用 `URL` + `searchParams` 而非手工拼字符串：`redirect_uri` 含 `://` 与 `:`
 * 必须被百分号编码，手工拼极易漏编码导致登录页校验失败。
 * 但 hash 段（`#/login`）不能用 `URL.searchParams` 构造 —— 它属于 fragment，
 * 故这里显式拼装：路径 + hash + `?` + 编码后的 query。
 */
export function buildLobsteraiLoginUrl(port, state, product) {
    const redirectUri = `http://127.0.0.1:${port}${LOBSTERAI_CALLBACK_PATH}`;
    const query = new URLSearchParams({
        source: 'electron',
        redirect_uri: redirectUri,
        state,
    });
    return `${product.portalBase}/portal#/login?${query.toString()}`;
}
/**
 * 用授权码换取凭据。
 *
 * 请求体**必须**含 5 个字段（对齐 `main.go:264-270`）：
 * `authCode` / `firstKeyfrom` / `latestKeyfrom` / `uuid` / `version`。
 * 其中 `uuid` 与 `firstKeyfrom` 来自 {@link LobsteraiLoginSession}，
 * `latestKeyfrom` 取当前时刻，`version` 用动态拉取的真值。
 *
 * 该端点**不需要** `Authorization` 头（换 token 时还没有 token）。
 *
 * @throws 当网络失败、信封 code 非 0、或响应缺 accessToken 时。
 */
export async function exchangeLobsteraiAuthCode(code, session, clientVersion, product, fetcher = fetch, signal) {
    const body = {
        authCode: code,
        firstKeyfrom: session.firstKeyfrom,
        latestKeyfrom: String(Date.now()),
        uuid: session.uuid,
        version: clientVersion,
    };
    const signalToUse = signal === undefined
        ? AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS)
        : AbortSignal.any([AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS), signal]);
    let response;
    try {
        response = await fetcher(`${product.apiBase}${LOBSTERAI_EXCHANGE_PATH}`, {
            method: 'POST',
            headers: lobsteraiAnonymousHeaders(product),
            body: JSON.stringify(body),
            signal: signalToUse,
        });
    }
    catch (error) {
        throw new Error(`LobsterAI exchange 网络失败：${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed;
    try {
        parsed = await response.json();
    }
    catch {
        throw new Error(`LobsterAI exchange 响应不是 JSON（HTTP ${response.status}）`);
    }
    const envelope = parseLobsteraiEnvelope(parsed);
    if (!envelope.ok) {
        throw new Error(`LobsterAI exchange 失败：${envelope.message}`);
    }
    const payload = parseLobsteraiTokenPayload(envelope.data);
    if (payload.accessToken.length === 0) {
        // 与 Go 的 `refresh_failed: no accessToken` 同理：没有令牌就没有可用的凭据，
        // 不能把半成品存进凭据库。
        throw new Error('LobsterAI exchange 响应缺少 accessToken');
    }
    return buildLobsteraiCredential(payload, {
        uuid: session.uuid,
        firstKeyfrom: session.firstKeyfrom,
        latestKeyfrom: body.latestKeyfrom,
    });
}
/** 把凭据包成一次登录流程的结果。 */
function toLoginFlowResult(credential, loginUrl) {
    return {
        access: JSON.stringify(credential),
        // 与 Buddy 侧一致：无法解析过期时间时报告 0，而不是抛错 ——
        // 凭据本身可用（只是有效期未知），不该因为展示层的缺失而登录失败。
        expires: lobsteraiCredentialExpiresAtMs(credential) ?? 0,
        loginUrl,
        refreshable: isLobsteraiRefreshable(credential),
    };
}
/** 默认的平台浏览器打开器（延迟 import 以复用 CodeArts 的既有实现）。 */
async function defaultOpenBrowser(url) {
    const { openBrowser } = await import('./login.js');
    openBrowser(url);
}
/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * `result` 已内置超时：两步式路径没有外层 try/finally 兜底，
 * 若超时不在此处生效，回调服务器会一直挂着。
 * 结果一旦落定就自动关闭服务器，避免两步式路径泄漏监听端口。
 */
export async function startLobsteraiLoginFlow(options) {
    const fetcher = options.fetcher ?? fetch;
    const { product, clientVersion } = options;
    const session = createLobsteraiLoginSession();
    const state = randomUUID();
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    // 这个 Promise 是手工创建的、要过一会儿才交给 `Promise.race` 消费，
    // 而回调处理器可能在「构造完成」与「被 await」之间就把它 reject 掉
    // （典型：用户浏览器回调极快，或 exchange 立刻失败）。那一段窗口里
    // Node 会把它视为**未处理的拒绝**并打印
    // `PromiseRejectionHandledWarning` / 触发 vitest 的 unhandled error。
    //
    // 先挂一个空处理器把「已处理」标记打上，可消除该告警；
    // 这不影响后续消费者 —— `Promise.race` 仍能拿到同一个拒绝原因。
    result.catch(() => { });
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`);
        if (!url.pathname.startsWith(LOBSTERAI_CALLBACK_PATH)) {
            response.writeHead(404).end('Not found');
            return;
        }
        const code = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');
        if (code === null || code.length === 0 || gotState !== state) {
            // state 不匹配说明回调不是本次登录发起的（或为伪造），按 Go 的做法直接拒绝。
            // 这里用 400 而不是静默忽略：让用户在浏览器里看到明确的失败反馈。
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调参数无效');
            return;
        }
        // 立即在本进程完成 exchange，成功/失败都先把浏览器页面对付了，
        // 否则用户会看到一个一直转圈的页面。
        //
        // 结果里的 loginUrl 用**回调请求实际落到的端口**（`socket.localPort`）
        // 现算，而不是捕获外层变量：回调服务器端口是在 `listen` 之后才知道的，
        // 先声明后赋值会让这个闭包引用一个尚未初始化的 const。
        void exchangeLobsteraiAuthCode(code, session, clientVersion, product, fetcher, options.signal)
            .then((credential) => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                .end('<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>');
            const port = request.socket.localPort ?? 0;
            resolveResult(toLoginFlowResult(credential, buildLobsteraiLoginUrl(port, state, product)));
        })
            .catch((error) => {
            response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录换取凭据失败');
            rejectResult(error);
        });
    });
    const port = await listenOnRandomPort(server);
    const loginUrl = buildLobsteraiLoginUrl(port, state, product);
    let closed = false;
    const close = async () => {
        if (closed)
            return;
        closed = true;
        await new Promise((resolve) => server.close(() => resolve()));
    };
    const resultWithTimeout = Promise.race([
        result,
        new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`LobsterAI 登录超时（${Math.round((options.timeoutMs ?? LOBSTERAI_LOGIN_TIMEOUT_MS) / 1000)} 秒内未完成）`)), options.timeoutMs ?? LOBSTERAI_LOGIN_TIMEOUT_MS);
            timer.unref?.();
        }),
    ]);
    // 结果落定即关闭服务器（含超时与失败路径）——两步式没有外层 finally。
    resultWithTimeout.catch(() => { }).finally(() => { void close(); });
    return { loginUrl, result: resultWithTimeout, close };
}
/**
 * 运行完整登录流程：起本地回调服务器 → 打开 portal → 等 `code` → exchange。
 *
 * 单进程内闭环，不落状态文件（见模块头注释）。
 *
 * `timeoutMs` 覆盖「浏览器打开 + 用户操作」整个窗口，超时抛错；
 * 无论成功失败都关闭本地服务器（`finally`）。
 *
 * 阻塞语义：打开浏览器并等用户完成授权后才返回。需要「立即拿到 URL」的
 * 场景（Jet Hub 两步式登录）请用 {@link startLobsteraiLoginFlow}。
 */
export async function runLobsteraiLoginFlow(options) {
    const open = options.openBrowser ?? defaultOpenBrowser;
    const started = await startLobsteraiLoginFlow(options);
    try {
        await open(started.loginUrl);
        return await started.result;
    }
    finally {
        await started.close();
    }
}
/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器，返回实际端口。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：回调只可能来自本机浏览器，
 * 不对外暴露监听面。
 */
function listenOnRandomPort(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            if (port === 0) {
                reject(new Error('LobsterAI 登录回调服务器未能获得端口'));
                return;
            }
            resolve(port);
        });
    });
}
//# sourceMappingURL=lobsterai-oauth.js.map