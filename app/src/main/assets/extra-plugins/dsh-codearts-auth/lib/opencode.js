/**
 * OpenCode V2 凭据、会话标识与代理地址归一。
 * session 不仅校验外形，还校验 descending 时间算法；V2 请求头与旧 CLI 不同。
 * project 仍按账号/匿名条目与代次派生 40hex，不改变账号池的指纹隔离语义。
 */
import { maskProxyPassword } from './proxy-mask.js';
import { createHash, randomBytes } from 'node:crypto';
import { OPENCODE } from './opencode-product.js';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/**
 * session id 尾段的**总长度**（12 位 hex 时间戳 + 随机段）。
 *
 * ⚠️ 取值 26 直接来自官方 `id/index.ts` 的 `const LENGTH = 26`；
 * 随机段长度 = `LENGTH - 12` = **14**。别把 26 当成随机段长度
 * （我第一版就是这么错的，代价是匿名通道全线 403）。
 */
const SESSION_TAIL_LENGTH = 26;
/** 随机段长度（26 - 12 = 14）。 */
const SESSION_RANDOM_LENGTH = SESSION_TAIL_LENGTH - 12;
/** 固定长度 base62 随机串（对齐官方 id 模块的 `randomBase62`）。 */
function randomBase62(length) {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++)
        out += BASE62[bytes[i] % BASE62.length];
    return out;
}
/**
 * 派生 project id。
 *
 * @param identity  账号标识（接线层传 API key；匿名槽传固定串 `'anonymous'`）。
 * @param generation 轮换代次。
 *
 * 刻意**不**把 key 全文直接进哈希链的明文位置：identity 先过 SHA-256，
 * 再以 `git-remote:` 前缀走 SHA-1 —— 既复用真实 CLI 的派生外形，
 * 又使明文 key 片段不出现在任何可从 project id 反推的中间量。
 */
export function deriveProjectId(identity, generation) {
    const inner = createHash('sha256').update(`${identity} ${generation}`).digest('hex');
    return createHash('sha1').update(`git-remote:opencode/${inner}`).digest('hex');
}
/**
 * ses_ + 12hex + 14base62；时间段为 ~(timestamp * 0x1000 + counter) 的低 48 位。
 * 使用 counter=1，随机段区分同毫秒生成的 ID；调用方缓存复用。
 * 旧实现把裸时间戳按小端写入，即使外形正确仍被上游算法校验拒绝。
 */
export function deriveSessionId(timestamp = Date.now()) {
    const value = ~(BigInt(timestamp) * 0x1000n + 1n) & 0xffffffffffffn;
    return `ses_${value.toString(16).padStart(12, '0')}${randomBase62(SESSION_RANDOM_LENGTH)}`;
}
/** 派生 request id（每请求一个，官方形态 `msg_` 前缀改 `req_`）。 */
export function deriveRequestId() {
    return `req_${randomBytes(16).toString('hex')}`;
}
/**
 * V2 UA 外形为 `opencode/<channel>/<version>/<client>`。
 *
 * ⚠️ 实测（2026-10-15，逐变量对照 2×2×2，每格 2 次）：UA **不参与**聊天门禁 ——
 * `user-agent: opencode/1.18.22`（本机 1.x CLI 的真实值）在其余两项正确时照样
 * HTTP 200。故这里把 2.x 覆盖成 `latest/<v>/cli`、把 1.x 回落成默认 V2 串，
 * 只是**外形一致**，不是过门禁的必要条件；别再把它写成「不换就 403」。
 * （真正必需的是 `x-opencode-session-id` 与降序 session 算法。）
 */
export function opencodeUserAgent(override) {
    const value = override?.trim() ?? '';
    if (/^opencode\/[A-Za-z0-9_-]+\/2\.\d+\.\d+\/cli$/.test(value))
        return value;
    const version = /^(?:opencode\/)?(2\.\d+\.\d+)$/.exec(value)?.[1];
    return version === undefined ? OPENCODE.defaultUserAgent : `opencode/latest/${version}/cli`;
}
/** 构造发往 V2（`/inference`）的完整指纹头集。 */
export function opencodeHeaders(fingerprint, sessionId, _requestId, userAgent) {
    // 保留旧调用签名但**绝不**发送 x-opencode-request。逐头实测（2026-10-15，每格 2 次）：
    // - 只带 project/session/client 三头（无 request、无 affinity）→ 403；
    // - 只加 `x-opencode-session-id` → **200**（唯一必需的那一个）；
    // - 只加 `x-session-affinity` 或只加 `X-Session-Id` → 403；
    // - 带上 `x-opencode-request`（即使三个 affinity 头都在）→ 403（旧客户端标记即毒药）。
    // 三个 affinity 头保留冗余只为贴合真实 CLI 外形，判定依据是上面这组对照。
    return {
        'x-opencode-project': fingerprint.projectId,
        'x-opencode-session': sessionId,
        'x-opencode-session-id': sessionId,
        'x-session-affinity': sessionId,
        'X-Session-Id': sessionId,
        'x-opencode-client': 'cli',
        'user-agent': opencodeUserAgent(userAgent),
    };
}
/**
 * 脱敏 URL 中的密码（面板与日志都只回显这个）。
 *
 * ⚠️ **实现已搬到 `src/proxy-mask.ts`**（2026-10-25 审计 A2-02）：
 * `account-pool.ts` 写日志时也要脱敏，而池**不能** import 本文件
 * （provider 实现在依赖图的上层）。放中立文件让两侧共用**同一份**判据 ——
 * 各写一份正是本仓库「同一语义两套判据」的红线。
 */
const maskLabel = maskProxyPassword;
/**
 * 从**原始输入**里取权威段（scheme 之后、path 之前）。
 *
 * ⚠️ 端口校验必须走这里而不是 `new URL(...).port`：WHATWG URL 会把
 * **显式的默认端口抹掉**（`new URL('https://h:443').port === ''`），
 * 于是「用户确实填了 443」会被误判成「缺端口」而拒绝一个完全合法的地址。
 */
function authorityOf(raw) {
    const afterScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    const cut = afterScheme.search(/[/?#]/);
    return cut === -1 ? afterScheme : afterScheme.slice(0, cut);
}
/** 权威段里是否带了显式端口（已剥掉 `user:pass@` 前缀）。 */
function hasExplicitPort(authority) {
    const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
    return /:\d+$/.test(hostPart);
}
/**
 * 归一用户输入的代理地址。
 *
 * 接受三类（设计文档 §3）：本地代理客户端端口（裸 `host:port`）、HTTP(S)、SOCKS5。
 * 空串表示「清除代理」，返回 `ok: false` 让调用方走清理分支。
 */
export function normalizeProxy(input) {
    const raw = input.trim();
    if (raw.length === 0)
        return { ok: false, reason: '代理地址为空（如需清除，请点「清除代理」）' };
    // 裸 host:port 补 http://（本地代理客户端端口最常见的填法）
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
    // socks5h:// 是 socks5 的「由代理解析 DNS」变体，undici 侧行为一致，归一为 socks5://
    const url = withScheme.replace(/^socks5h:\/\//, 'socks5://');
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return { ok: false, reason: '无法解析为 URL（形如 http://host:port）' };
    }
    const kind = parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? 'http'
        : parsed.protocol === 'socks5:'
            ? 'socks5'
            : undefined;
    if (kind === undefined) {
        return { ok: false, reason: `不支持的协议 ${parsed.protocol.replace(':', '')}（仅支持 http/https/socks5）` };
    }
    if (parsed.hostname.length === 0)
        return { ok: false, reason: '缺少主机名' };
    // ⚠️ 端口存在性从**原始串**的权威段判（见 `hasExplicitPort` 的注释），
    // 不用 `parsed.port` —— 后者会把用户显式写的 443/80 抹成空串。
    if (!hasExplicitPort(authorityOf(raw)))
        return { ok: false, reason: '缺少端口（如 http://127.0.0.1:7897）' };
    // ⚠️ 手工拼接而非直接用 `parsed.toString()`：后者会规范化默认端口、
    // 补尾斜杠，产生与用户输入不一致的 URL。这里只取已确认存在的 host:port。
    const scheme = kind === 'socks5' ? 'socks5' : parsed.protocol.replace(':', '');
    const auth = parsed.username.length > 0
        ? `${parsed.username}${parsed.password.length > 0 ? `:${parsed.password}` : ''}@`
        : '';
    // ⚠️ 端口用权威段里解析出来的**原始数字**（`parsed.port` 可能是空串）。
    const rawHostPort = authorityOf(raw);
    const hostOnly = auth.length > 0 ? rawHostPort.slice(rawHostPort.lastIndexOf('@') + 1) : rawHostPort;
    const portMatch = /:(\d+)$/.exec(hostOnly);
    const port = portMatch?.[1] ?? parsed.port;
    const normalized = `${scheme}://${auth}${parsed.hostname}:${port}`;
    return { ok: true, proxy: { kind, url: normalized, label: maskLabel(normalized) } };
}
//# sourceMappingURL=opencode.js.map