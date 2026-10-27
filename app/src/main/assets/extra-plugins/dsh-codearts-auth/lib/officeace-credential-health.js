/**
 * OfficeAce（华为 MaaS）**凭据级熔断**：连续若干次「Basic 凭据被服务端拒绝」之后，
 * 在一段时间内把该凭据从聚合候选表里剔除，并让适配器**快速失败**。
 *
 * ## 为什么需要它（Gitee issue IKLTHB 的第 ③ 条）
 *
 * 真实报障（2026-10-14 起，264+ 次连续失败）：
 *
 * ```
 * OfficeAce (华为MaaS) 返回 HTTP 401：{"error_msg":"AppKey or AppSecret is invalid",
 *                                     "error_code":"APIG.1009"}
 * ```
 *
 * 这条 401 **不是**「额度用尽」也不是「会话过期」—— 它是华为 APIG 对
 * `modelAppKey:modelAppSecret` 这对 Basic 凭据的**确定性拒绝**：同一对凭据重发多少次
 * 都是同一个结果（报文里那句 `APIG.1009` 就是「这对 key 我不认」）。
 *
 * 而在本模块之前，聚合链路上**没有任何东西**把这条事实记下来：
 *
 * | 层 | 改前的行为 |
 * |---|---|
 * | `officeaceExpiry`（聚合折算） | 走 V11 签名读 `/v1/subscription`（**另一套鉴权**），读得到余额 ⇒ 折算成一个正常值 ⇒ officeace **留在候选表里，甚至排第一** |
 * | `officeace-adapter.stream` | 照发请求 ⇒ 401 ⇒ 抛错 |
 * | 聚合兜底 | 换下一个渠道 ⇒ 这一轮用户白等一次，还会连带触发「max → high」这类档位降级 |
 *
 * ⇒ 每一轮都**先撞同一堵墙**再改道。本模块把「这对凭据已被服务端拒绝」变成一个
 * **有 TTL、会自动解除**的状态，让折算层提前把它剔除（见 `aggregate-expiry.ts`
 * 的 `officeaceExpiry`），**同时**让适配器在熔断期内不再发那个注定 401 的请求。
 *
 * ## ⚠️ 三条不能写错的性质（本仓库踩过同型的坑）
 *
 * 1. **必须自动过期**（`until` 到期即视为关闭）：`refreshable` 单向门与 zcode
 *    持久标记两次事故的教训 —— 一个**不会自己解除**的标记会让渠道永久消失，
 *    而用户看到的是「明明有额度却选不到」。
 * 2. **必须能被成功清除**：任何一次成功请求（200）都 `delete` 掉本条的记录。
 * 3. **半开（half-open）语义**：熔断到期后放行；若又失败，因为计数器仍在阈值上，
 *    会**立刻**重新熔断（而不是再攒 N 次）—— 这正是断路器该有的形状，
 *    故这里**刻意不在到期时清零计数**。只有成功才清零。
 *    ⚠️ 如实登记：判据只有 `until <= now`（见 `officeaceBreakerState`），
 *    **没有 in-flight 闸门** ⇒ 到期**那一瞬间**并发到达的 N 个请求会**各自**
 *    放行一次（上界 = 那一瞬的并发数，随后第一次失败立即重熔）。
 *    代价是「每 10 分钟最多多打几次注定 401 的请求」，故不为它加单飞机制；
 *    别把这条读成「严格只探测一次」。
 *
 * ## ⚠️ 表的淘汰语义（读代码的人不必自己推）
 *
 * - 记录**只在** `noteOfficeaceSuccess` 里被 `delete`（成功即清除）；
 * - TTL 到期**不删记录**（半开需要计数留着），只是不再算「熔断中」；
 * - `DSH_OFFICEACE_BREAKER_MINUTES=0`（关闭）时记录与 `consecutive` 仍会累积，
 *   但 `officeaceBreakerOpen` 恒假 ⇒ 只影响观测，不会拦请求；
 * - 上界 = 进程内见过的**不同 Basic 密钥对**数量（指纹只含 key/secret），
 *   对单机用户而言有界且极小 —— 这也是本模块敢用纯内存 Map 的理由。
 *
 * ## 为什么键是「凭据指纹」而不是账号 id / credentialRef
 *
 * 被拒绝的东西**就是那对 key**（报文写得很明白）。而 issue 里取证到的最刺眼的事实是：
 * **重新登录换掉了账号与 ref（`OFFICEACE_ACCOUNT_651558E5` → `F1557964`）、
 * 换掉了整条 STS 三元组，却让 `modelAppKey` / `modelAppSecret` 逐字节不变**
 * （`ffff8ba7…c476` / `bd4da972…d76b`，`accountId` 也没变）。
 *
 * ⇒ 按 ref 记账会得出错误结论（「新账号，重新试」），按指纹记账才是对的：
 * **同一对 key 换个账号壳子照样被拒**，而 key 真换了（或 secret 轮换了）就该重试。
 * 这条也顺带解决了重登录造出来的**幽灵账号**（`account.create` 恒新造 id + ref）：
 * 它们与真账号同指纹 ⇒ 一起被熔断，不会各撞一次。
 *
 * ⚠️ 指纹存**哈希**不存原文：本表是模块级内存，且会被日志/诊断间接引用，
 *    没有理由让 `modelAppSecret` 以明文在进程里多留一份。
 *
 * ## 为什么是纯内存、不落盘
 *
 * 与 `officeace-auth.ts` 的订阅缓存不同，这是一个**短期健康标记**：重启后最多
 * 再撞一次就会重新熔断（阈值 2），而落盘要新增一份带 schema 的状态文件、
 * 还要处理「跨进程/跨用户共享」的归属问题（`DSH_HOME` 可能是同一个）。
 * 收益不抵复杂度 —— 与 `auto-adapter` 的零输出冷却表同款取舍。
 */
import { createHash } from 'node:crypto';
/**
 * 熔断时长的环境变量名（分钟）。
 *
 * ⚠️ **允许写 `0`**：`0` = **关闭熔断**（每次都真发请求）。
 *    需要它是因为熔断会「让渠道提前消失」—— 若某次误判（例如华为侧短暂抖动
 *    连回两个 401），用户至少有一条不用改代码的出路。与
 *    `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 同型。
 */
export const DSH_OFFICEACE_BREAKER_MINUTES = 'DSH_OFFICEACE_BREAKER_MINUTES';
/** 默认熔断时长（分钟）。取 10 分钟：比一次「排队/抖动」长，比用户忍耐短。 */
export const OFFICEACE_BREAKER_DEFAULT_MINUTES = 10;
/**
 * 连续多少次「确定的凭据拒绝」才熔断。
 *
 * ⚠️ 取 **2** 而不是 1：本适配器在 401 时已经先续期再重发一次（见
 *    `officeace-adapter.ts`），一次用户请求里最多产生**一次**终态 401；
 *    阈值 1 会让**任何一次**抖动单独触发熔断。取 2 = 「连续两次都这样」才认。
 */
export const OFFICEACE_BREAKER_THRESHOLD = 2;
/** 当前生效的熔断时长（分钟）；`0` 表示关闭熔断。 */
export function officeaceBreakerMinutes(env = process.env) {
    const raw = env[DSH_OFFICEACE_BREAKER_MINUTES];
    if (typeof raw !== 'string' || raw.trim().length === 0)
        return OFFICEACE_BREAKER_DEFAULT_MINUTES;
    const parsed = Number(raw.trim());
    // ⚠️ **不能写成 `Number(raw) || 默认值`**：`0` 是合法值（关闭熔断）却是 falsy，
    //    会被静默换成默认值 —— 与 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 同一个坑。
    if (!Number.isFinite(parsed) || parsed < 0)
        return OFFICEACE_BREAKER_DEFAULT_MINUTES;
    return parsed;
}
/** 当前生效的熔断时长（毫秒）。 */
export function officeaceBreakerMs(env = process.env) {
    return officeaceBreakerMinutes(env) * 60 * 1000;
}
/**
 * 凭据指纹：`sha256(modelAppKey + \0 + modelAppSecret)` 取前 16 个 hex 字符。
 *
 * ⚠️ **与「该不该重发一次」的判据不是一回事**（别合并两处）：
 * - 本指纹回答「**这是不是那对已被拒绝的 key**」⇒ 只含 Basic 二元组；
 * - 适配器里的 `basicAuthFingerprint` 回答「**重发一次有没有意义**」⇒ 还要含
 *   `maasBaseUrl`（2026-10-13 那个真实缺陷：网关按账号下发，打错 host 恒 401，
 *   而那时**只有 base URL 变了**）。两者目标不同，故各自一份并各自说明。
 *
 * @returns 空串表示该凭据没有可用的 Basic 二元组（此时**不参与熔断**：
 *          连身份都取不到，把整池一起熔断是过度反应）。
 */
export function officeaceCredentialFingerprint(credential) {
    const key = typeof credential?.modelAppKey === 'string' ? credential.modelAppKey : '';
    const secret = typeof credential?.modelAppSecret === 'string' ? credential.modelAppSecret : '';
    if (key.length === 0 || secret.length === 0)
        return '';
    return createHash('sha256').update(`${key}\u0000${secret}`).digest('hex').slice(0, 16);
}
/** 模块级状态：指纹 → 记录（**纯内存**，见模块头「为什么不落盘」）。 */
const rejections = new Map();
/**
 * 记一次「确定的凭据拒绝」（调用方必须**先**确认报文形状，见
 * `isBasicCredentialRejection`）。
 *
 * @param credential - 被拒的那份凭据（取指纹）。
 * @param body - 服务端报文（截断后记录，供诊断复用）。
 * @param now - 便于单测注入固定时刻。
 * @param env - 便于单测注入熔断时长。
 * @returns 本次调用之后的熔断状态（`until` 是否已生效）。
 */
export function noteOfficeaceRejection(credential, body = '', now = Date.now(), env = process.env) {
    const fingerprint = officeaceCredentialFingerprint(credential);
    if (fingerprint.length === 0)
        return { open: false, consecutive: 0 };
    const previous = rejections.get(fingerprint);
    const consecutive = (previous?.consecutive ?? 0) + 1;
    const minutes = officeaceBreakerMinutes(env);
    const shouldOpen = minutes > 0 && consecutive >= OFFICEACE_BREAKER_THRESHOLD;
    const record = {
        consecutive,
        // ⚠️ **半开语义**：到期后若又失败，计数仍在阈值上 ⇒ 立刻重新熔断（见模块头第 3 条）。
        until: shouldOpen ? now + minutes * 60 * 1000 : 0,
        lastReason: body.slice(0, 200),
    };
    rejections.set(fingerprint, record);
    return { open: shouldOpen, consecutive };
}
/**
 * 记一次成功：**清零并删除**该凭据的记录（熔断的唯一正常出口）。
 *
 * ⚠️ 删除而不是把 `until` 置 0：留着一条 `consecutive: 1` 的记录会让下一次
 *    偶发 401 直接熔断（阈值 2 形同 1）—— 而「成功过」恰恰证明这对 key 是好的。
 */
export function noteOfficeaceSuccess(credential) {
    const fingerprint = officeaceCredentialFingerprint(credential);
    if (fingerprint.length === 0)
        return;
    rejections.delete(fingerprint);
}
/**
 * 当前熔断状态。
 *
 * @param now - 便于单测注入固定时刻。
 * @param env - 便于单测注入熔断时长（`0` = 关闭 ⇒ 恒不熔断）。
 * @returns `open` 为真时 `remainingMs` 是剩余熔断时长；否则为 0。
 */
export function officeaceBreakerState(credential, now = Date.now(), env = process.env) {
    const closed = { open: false, remainingMs: 0, consecutive: 0, lastReason: '' };
    const fingerprint = officeaceCredentialFingerprint(credential);
    if (fingerprint.length === 0)
        return closed;
    const record = rejections.get(fingerprint);
    if (record === undefined)
        return closed;
    // ⚠️ `0`（关闭熔断）必须在这里也生效：关掉之后已在熔断中的那条要**立刻**放行，
    //    否则「改配置不生效、得等 10 分钟」会变成一个说不清的症状。
    if (officeaceBreakerMs(env) <= 0)
        return { ...closed, consecutive: record.consecutive, lastReason: record.lastReason };
    // ⚠️ 判据是 `until > now`（到期即自动解除，无需清理任务）——与
    //    `zero-output-guard.isTargetCoolingDown` 同款，本仓库反复强调的「单向门」防线。
    if (record.until <= now)
        return { ...closed, consecutive: record.consecutive, lastReason: record.lastReason };
    return {
        open: true,
        remainingMs: record.until - now,
        consecutive: record.consecutive,
        lastReason: record.lastReason,
    };
}
/** 该凭据当前是否处于熔断中（折算层的判据）。 */
export function officeaceBreakerOpen(credential, now = Date.now(), env = process.env) {
    return officeaceBreakerState(credential, now, env).open;
}
/**
 * 服务端报文是否是**确定的 Basic 凭据拒绝**。
 *
 * ## ⚠️ 为什么必须按报文形状判，而不能「凡 401 都算」
 *
 * 401 在本渠道至少有三种来源，只有第一种能证明「这对 key 是死的」：
 *
 * | 形态 | 报文 | 归因 |
 * |---|---|---|
 * | **APIG.1009** | `AppKey or AppSecret is invalid` | 凭据本身被拒 ⇒ **可熔断** |
 * | APIG.0301 | 验签失败（V11 签名那套，管理面） | 与 Basic 推理面无关 |
 * | 网关 / 代理层 401 | HTML 或空体 | 形状未知 ⇒ **不熔断**（宁可多撞一次，不可误伤） |
 *
 * ⚠️ 华为官方文档把 `APIG.1009` 定义为 HTTP **400**，而真机收到的是 **401**
 *    （issue 里已取证）⇒ 判据**不得**钉死某一个状态码。但也**不能**彻底不看状态码：
 *
 * | 状态码 | 算不算凭据拒绝 | 理由 |
 * |---|---|---|
 * | **4xx**（400 / 401 / 403…） | ✅ | 客户端错误类；报文点名了这对 Basic 凭据 ⇒ 就是它被拒 |
 * | **2xx** | ❌ | ⚠️ 成功响应的 body 是**模型输出** —— 用户正是在排查这个错误，模型完全可能原样复述这句报文 ⇒ 不设下界会让一次**成功的回答**把整个渠道熔断 10 分钟 |
 * | **5xx** | ❌ | 基础设施抖动，形状未知 ⇒ 宁可多撞一次，不可误伤整渠道（与「网关空体 401 不熔断」同一条理由） |
 *
 * 边界刻意画在**状态类**（4xx）而不是枚举具体码：文档说 400、真机是 401，
 * 再冒出个 403 包装层也不该漏。⚠️ 第二轮对抗性审计实测出的真实缺口：
 * 原判据写的是 `status !== 401 ⇒ false`，与它自己上面那句「不得依赖状态码」
 * **自相矛盾**，而 `credential-health.spec` 的 ④ 还把「400 + 真机报文 ⇒ false」
 * 当成期望值钉住了（标题却写着「只认报文，不认状态码」）。
 */
export function isBasicCredentialRejection(status, body) {
    if (!(status >= 400 && status < 500))
        return false;
    // ⚠️ 两条腿都要（码腿 + 措辞腿）：码是权威，但网关包装层可能改码；
    //    措辞来自真机报文原文。与 qoder「额度类业务码不是一个值，是一条链」同型。
    return /APIG\.1009/i.test(body) || /AppKey or AppSecret/i.test(body);
}
/** 仅供单测：清空全部熔断记录（跨用例污染会让断言随机红）。 */
export function resetOfficeaceBreakerForTest() {
    rejections.clear();
}
//# sourceMappingURL=officeace-credential-health.js.map