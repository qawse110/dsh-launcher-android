/**
 * opencode 专用 RPC 的**方法处理函数**（不是自注册端点）。
 *
 * ## ⚠️⚠️ 为什么是「被主 switch 调用」而不是「自己注册」（真实事故 2026-10-02）
 *
 * 我最初在这里调 `rpc.register('jet-hub', handler)`，以为可以与
 * `jet-hub-rpc.ts` 并存。真机报障：
 *
 *     添加失败：unknown method: opencode.addAnonymous
 *
 * 根因：**Jet Hub 只有一条通道** —— `jet-hub-rpc.ts` 的
 * `connection.fetch.register({ path: JET_HUB_API_PATH })`，它把 `call.method`
 * 交给一个穷举 `switch`，`default` 分支直接回 `unknown method` 且**不让路**。
 * 仓库里 `rpc.register` 只有我这一处用到（其它 11 个 provider 全部走主 switch），
 * 所以我那条注册路径从来就没被接过请求。
 *
 * ⇒ 现在本文件只导出 {@link handleOpencodeRpc}，由 `jet-hub-rpc.ts` 的
 * `handleMethod` 在 `default` **之前**调用。文件边界的好处（评审 diff 可控）
 * 保留了，错误的注册方式去掉了。
 *
 * ## 与既有 RPC 的关系
 *
 * 账号的增删改、拖拽排序、限流标记**全部复用** `account.*` 族；
 * 这里只加 opencode 特有的五件事。其中「添加账号」是本插件第一家
 * **不跳浏览器**的登录方式（手动粘贴 API key）。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { createHash, randomBytes } from 'node:crypto';
import { OPENCODE } from './opencode-product.js';
import { newAccountFingerprint, nextFingerprintGeneration } from './opencode-auth.js';
import { normalizeProxy } from './opencode.js';
import { proxyFetch } from './opencode-proxy.js';
/**
 * 把 fetch 抛出的错误整理成**带根因**的可读串。
 *
 * ## ⚠️ 为什么不能只取 `error.message`（issue IKK4BY 第 2 点）
 *
 * Node 的 `fetch` 在**任何**传输层失败时抛的 `TypeError` 其 `message` 恒为
 * `'fetch failed'`，真正原因（`ECONNREFUSED` / `ENOTFOUND` / `UND_ERR_*` /
 * TLS 握手失败 …）只挂在 `error.cause` 上。只取 message 的后果是**所有**故障
 * 都退化成同一句无信息量的话 —— 本 issue 的报障正是这样：
 * 「固定显示测试失败 fetch failed，耗时 0 到 1 毫秒」，用户与排障者都无从下手。
 *
 * 这里逐层展开 `cause`（fetch 的 cause 还可能再套一层），最多 3 层，
 * 避免病态的自引用链把日志撑爆。
 */
export function describeFetchError(error) {
    const parts = [];
    let current = error;
    /**
     * ⚠️ **两个上限分工不同，不能只用一个 depth 计数**：
     * - `TRAVERSE_CAP`：遍历次数硬上限，防自引用/环形 cause 死循环；
     * - `MAX_PARTS`：真正进输出的条数上限，控制可读性。
     *
     * 若只用 `depth < 3` 同时兼任两者，「被跳过的无信息量层」会**白白吃掉输出预算**，
     * 把真正的根因挤出窗口 —— 实测反例（自审时用真实实现跑出来的）：
     *
     *     outer → mid → fetch failed → connect ECONNREFUSED 127.0.0.1:45999
     *     旧实现输出：`outer ← mid`（**根因丢了**）
     *     新实现输出：`outer ← mid ← connect ECONNREFUSED …`（根因保住）
     */
    const TRAVERSE_CAP = 8;
    const MAX_PARTS = 3;
    for (let i = 0; i < TRAVERSE_CAP && current !== null && current !== undefined; i += 1) {
        if (!(current instanceof Error)) {
            if (parts.length < MAX_PARTS)
                parts.push(String(current));
            break;
        }
        // ⚠️ `code` 是 undici / Node 系统错误的关键判据（如 UND_ERR_INVALID_ARG），
        // 它不在 message 里，必须显式带出。
        const code = current.code;
        const suffix = typeof code === 'string' && code.length > 0 && !current.message.includes(code)
            ? ` (${code})`
            : '';
        /**
         * 「无信息量」判据：`TypeError: fetch failed` 与空 message 都只是噪音，
         * 但**只在后面还有 cause 可展开时**才跳过 —— 若它就是全部（没有 cause），
         * 保留原样，免得报出一句空话。
         *
         * ⚠️ `hasMore` 必须用 `!= null`（同时覆盖 `undefined` 与 `null`）：
         * 只判 `=== undefined` 时 `cause = null` 会走进「无 cause」分支，
         * 输出带 `Error: ` 前缀的噪音（自审实测：`Error: fetch failed`）。
         */
        const hasMore = current.cause != null;
        const noisy = (current.message === 'fetch failed' || current.message.length === 0) && hasMore;
        if (!noisy && parts.length < MAX_PARTS)
            parts.push(`${current.message}${suffix}`);
        current = current.cause;
    }
    // ⚠️ 兜底也要覆盖「只收到空串」的情况：`new Error('')` 会产出 `['']`，
    // 若直接 join 会得到空字符串，UI 上显示成「测试失败：」后面什么都没有。
    if (parts.length === 0 || parts.every((part) => part.length === 0))
        return String(error);
    return parts.join(' ← ');
}
/**
 * key 形状：**不绑定任何前缀**，只粗筛「像不像一个粘贴过来的密钥串」——
 * 至少 20 位、无空白、URL-safe 令牌字符集（覆盖 base64url 与
 * `oc_sk_1a2b3c4d5e6f_…` 这种带分隔符的形态）。
 *
 * ⚠️⚠️ 这里**曾经**写死 `^sk-…`。opencode 2026-10-22 起签发的 key 改成
 * `oc_sk_` 开头（Gitee **IKPLRU**：新 key 被这道闸**全部**挡在门外，报
 * 「应以 sk- 开头」，用户无法添加任何账号）。**前缀是上游会改的东西**，
 * 判据只能落在与上游命名无关的共性上 ⇒ **不要把某个具体前缀写回来**
 * （旧 `sk-` key 仍需可用，故也不能改成「只认 oc_sk_」）。
 *
 * ⚠️ 这只是**形状**校验（挡手滑/占位符），**不是**有效性验证：
 * 真 key 仍要等第一次真实请求才知道。形状校验的价值是让「明显没粘贴对」
 * 在入库前就被挡下，而不是等到发消息时才 401。
 */
const KEY_PATTERN = /^[A-Za-z0-9_.-]{20,}$/;
/** 出口 IP 查询（公开服务，仅用于「测试代理」按钮，不承载业务流量）。 */
const EXIT_IP_URL = 'http://ip-api.com/json/?fields=status,query,country';
/** 探测连接用的超时（测试按钮不能无限等）。 */
const TEST_TIMEOUT_MS = 10_000;
/**
 * 匿名通道的 id 前缀 —— **全仓唯一的判据来源**。
 *
 * `src/index.ts` 的 `ensureDefaultAnonymousSlot`（「池里已经有匿名槽了吗」）
 * 与客户端的 `isAnonymousAccountId`（`plugin-src/client/jet-hub.js`）都按这个
 * 前缀判。三处必须同形，故这里导出常量供守卫用例对拍。
 */
export const OPENCODE_ANONYMOUS_ID_PREFIX = `${OPENCODE.id}-anon-`;
/**
 * 账号 id / credentialRef 由 key 尾段派生，使重复 key 落到同一账号。
 *
 * ⚠️⚠️ **两段必须分开算**：`id` 允许 `-`（只是池里的字符串键），而
 * `credentialRef` 走 `credentialRef()`，其 `REF_PATTERN` 只认
 * `[A-Za-z_][A-Za-z0-9_]*` —— 尾段里只要有一个 `-` 或 `.`（base64url 的
 * key 很常见，实测 `sk-…-d-e-f-g` 就命中），原本会**抛出 TypeError**，
 * 用户看到的是 `credential ref "OPENCODE_ACCOUNT_-D-E-F-G" must match …`
 * 这条与 key 毫无关系的报错，且账号**写不进去**（2026-10-22 复现）。
 *
 * ⇒ 归一化**只在尾段不合法时**发生：合法尾段的 ref 逐字节不变
 * （存量账号的凭据引用不能被改动），不合法时才做字符替换，并追加 key 的
 * 短哈希补足判重信息 —— 纯替换会让 `…ab-cd` 与 `…ab_cd` 撞成同一个 ref，
 * 后添加的账号会**覆盖**前者的凭据。
 *
 * ## ⚠️⚠️ `id` 不得落进**匿名槽命名空间**（2026-10-25 审计 A1-F14 / B1）
 *
 * 尾 8 位恰为 `anon-abc` 这类形态的 key 会产出 `opencode-anon-abc` —— 与
 * 匿名通道**前缀相同**。后果是**静默的功能损失**（零报错）：
 *
 * 1. 客户端按该前缀判「这是匿名通道」⇒ 打匿名标签、按匿名口径渲染；
 * 2. `ensureDefaultAnonymousSlot` 判「已经有匿名槽了」⇒ **永久跳过**创建
 *    默认匿名槽 ⇒ 零账号的新用户**失去免费通道**。
 *
 * 旧实现（本 PR 之前）这条路径**不可达**：含 `-` 的尾段会先在
 * `credentialRef()` 抛 TypeError、根本进不了池；本 PR 放宽字符集后才成立
 * ⇒ 属**本 PR 新引入**的可达缺陷，必须在本 PR 内修掉。
 *
 * ⇒ 只在**确实会撞前缀**时改派生（加 `key-` 段），合法且不撞的存量 id
 * **逐字节不变**（否则存量账号会被当成新账号另建一条）。
 */
function slotNamesOf(apiKey) {
    const tail = apiKey.slice(-8);
    const upper = tail.toUpperCase();
    const refName = /^[A-Z0-9_]*$/.test(upper)
        ? `OPENCODE_ACCOUNT_${upper}`
        : `OPENCODE_ACCOUNT_${upper.replace(/[^A-Z0-9_]/g, '')}_${createHash('sha256').update(apiKey).digest('hex').slice(0, 8).toUpperCase()}`;
    const derived = `${OPENCODE.id}-${tail.toLowerCase()}`;
    // ⚠️ 只改**会撞**的那一档：多插一个 `key-` 段，使 id 不再以匿名前缀开头。
    //    不可改为「统一加前缀」—— 那会让全部存量账号的 id 变化。
    const id = derived.startsWith(OPENCODE_ANONYMOUS_ID_PREFIX)
        ? `${OPENCODE.id}-key-${tail.toLowerCase()}`
        : derived;
    return { id, refName };
}
/**
 * 判断一个 `credentialRef` 名字是否可用（`credentialRef()` 的 `REF_PATTERN`）。
 *
 * ⚠️ 与 `@deepseek-ai/dsh-credentials` 的 `REF_PATTERN`（`/^[A-Za-z_][A-Za-z0-9_]*$/`）
 * **同形**，但这里**不 import 那个常量**（它没导出）。故本判据是「宽松预检」：
 * 不合法就绕开它，绝不拿它去调 `credentialRef()`（那样会抛 TypeError，而本函数
 * 的存在意义正是「不要抛」）。真正的不变量仍由 `credentialRef()` 自己守。
 */
function isUsableRefName(ref) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref);
}
/**
 * 「这个账号槽的凭据现在还能用吗」—— 供 `opencode.addAccount` 的复用判据使用。
 *
 * ## ⚠️ 三态而不是布尔（这是本函数存在的全部理由）
 *
 * 两种「不能用」的成因**后果完全相反**，混成一个 `false` 会造成真缺陷：
 *
 * | 返回值 | 含义 | 正确处置 |
 * |---|---|---|
 * | `'same-key'` | 凭据完好，且 `api_key` 与本次**相同** | 复用（`existed: true`） |
 * | `'missing'` | 读不到 / 非 JSON / `api_key` 为空 | **坏槽 ⇒ 覆盖写**（修复用户的自救路径） |
 * | `'other-key'` | 凭据完好，但 `api_key` **不同** | **不得覆盖**（那是同一尾段上的另一把 key，覆盖会改掉别人的号） |
 *
 * 把 `'other-key'` 也当成坏槽（= 返回 false 就覆盖）会**改掉用户已有的那个账号**
 * —— 他以为在加新号，实际把旧号换成了新 key。这正是本函数必须三态的原因。
 *
 * ⚠️ `resolve` 抛错也按 `'missing'` 处理：凭据文件不可读时不该让整个
 * addAccount 崩掉（那会连修复路径一起堵死）。
 * ⚠️ 入参 `ref` 若形态不合法，直接 `'missing'`，**不要**拿它去 `credentialRef()`
 * （那里会抛 TypeError；行枚举里也可能留下手工编辑的脏 ref）。
 */
async function classifyExistingCredential(ctx, ref, expectedApiKey) {
    if (!isUsableRefName(ref))
        return 'missing';
    let resolved;
    try {
        resolved = await ctx.credentials.resolve(credentialRef(ref));
    }
    catch {
        return 'missing';
    }
    const raw = resolved?.value;
    if (typeof raw !== 'string' || raw.length === 0)
        return 'missing';
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return 'missing';
    }
    if (typeof parsed !== 'object' || parsed === null)
        return 'missing';
    const apiKey = parsed.api_key;
    if (typeof apiKey !== 'string' || apiKey.length === 0)
        return 'missing';
    return apiKey === expectedApiKey ? 'same-key' : 'other-key';
}
/**
 * 处理一个 opencode RPC 方法。
 *
 * @param method 来自主 `handleMethod` 的方法名。
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（这样它自己的 `default`
 *          分支仍能给出 `unknown method`，语义归属清晰）。
 *
 * ⚠️ 不认识时**必须**返回 `undefined` 而不是 `{ok:false}`：主 switch 会在
 * `default` 之前调用本函数，若本函数对未知方法也回信封，别的 provider 的
 * 方法名就会被误判成「格式错误」而不是「没这个方法」。
 */
export async function handleOpencodeRpc(ctx, pool, method, payload) {
    const fail = (message) => ({ ok: false, error: { code: 'bad-request', message } });
    const done = (value) => ({ ok: true, value });
    const call = { method, payload };
    try {
        switch (method) {
            case 'opencode.addAccount': {
                const req = call.payload;
                const apiKey = typeof req?.apiKey === 'string' ? req.apiKey.trim() : '';
                if (!KEY_PATTERN.test(apiKey)) {
                    return fail('API Key 形状不对（应为 20 位以上、不含空格的密钥串；可在 https://opencode.ai/console/account 生成）');
                }
                const { id, refName } = slotNamesOf(apiKey);
                // ⚠️ 重复 key 必须**复用**同一账号：同 key 加两次会让用户误以为是
                // 两个独立配额桶，实际请求仍会打到同一份额度上（并在限额时一起被跳过）。
                //
                // ⚠️⚠️ **但「池里有这个 id」≠「这条账号是好的」**（2026-10-25 审计 P1-1）：
                // 「账号在、凭据缺」是**产品自己能造出来**的状态 —— `exportBackup`
                // 遇到凭据缺失的账号时把账号写进备份、凭据从字典里略掉（只留一条
                // warning），用 replace 模式导回就得到 `credentialsImported=0`。
                // 旧实现在这里**无条件** `return existed:true`，而源码顺序证明它是
                // **根本没走到写**（不是写失败）⇒ 用户粘贴正确 key 想修好它，
                // 看到的是「该 key 已存在，已为你定位到原有账号」（以为修好了），
                // 而该账号在推理路径被 `api_key ?? OPENCODE.anonymousKey` 降级成
                // **匿名免费通道** ⇒ 付费 key 完全失效，**面板卡片一切正常、零日志**。
                // 而 opencode **没有** `setApiKey`（对照 `modelscope.setApiKey`），
                // 唯一出路是「先删后加」——用户没有任何线索指向它。
                //
                // ⇒ 命中同 id 时**先确认凭据真的能读出来**：读不到 / 损坏 /
                // 空 api_key ⇒ 视为「这个槽是坏的」，覆盖写凭据并如实回报
                // `existed:false`（不能再说「已存在」）。
                const existing = pool.listAccountsByProvider(OPENCODE.id).find((a) => a.id === id);
                if (existing !== undefined) {
                    const state = await classifyExistingCredential(ctx, existing.credentialRef, apiKey);
                    if (state === 'same-key') {
                        return done({ accountId: id, existed: true });
                    }
                    // ⚠️ `other-key` **不得覆盖**：同一尾段上是另一把 key，覆盖会改掉
                    //    用户已有的那个号（他以为在加新号）。如实按「已存在」复用，
                    //    与旧行为一致 —— 这条是「不要过度修复」的边界。
                    if (state === 'other-key') {
                        return done({ accountId: id, existed: true });
                    }
                    // 覆盖写：把凭据落到**该条目当前引用的 ref** 上（不新造 ref，
                    // 否则池里的 credentialRef 与新写的 ref 对不上，等于没修）。
                    // ⚠️ 若条目自己的 ref 不合法（手工编辑过的 state.json），
                    // 退回本次算出的 refName 并用 updateAccount 纠正引用。
                    const targetRef = isUsableRefName(existing.credentialRef)
                        ? existing.credentialRef
                        : refName;
                    const repairNickname = typeof req.nickname === 'string' && req.nickname.trim().length > 0
                        ? req.nickname.trim()
                        : `OpenCode ${apiKey.slice(-6)}`;
                    await ctx.credentials.set(credentialRef(targetRef), JSON.stringify({
                        api_key: apiKey,
                        nickname: repairNickname,
                        fingerprint: newAccountFingerprint(apiKey),
                    }));
                    if (targetRef !== existing.credentialRef) {
                        await pool.updateAccount(id, { credentialRef: targetRef });
                    }
                    return done({ accountId: id, existed: false });
                }
                const nickname = typeof req.nickname === 'string' && req.nickname.trim().length > 0
                    ? req.nickname.trim()
                    : `OpenCode ${apiKey.slice(-6)}`;
                await ctx.credentials.set(credentialRef(refName), JSON.stringify({
                    api_key: apiKey,
                    nickname,
                    // 指纹在此**首次固化**，之后由池里的代次权威重算（见 index.ts 接线注释）。
                    fingerprint: newAccountFingerprint(apiKey),
                }));
                await pool.addAccount({
                    id,
                    provider: OPENCODE.id,
                    nickname,
                    enabled: true,
                    credentialRef: refName,
                    // ⚠️ 手动粘贴的 key 没有 refresh_token 概念（Zen key 不过期），
                    // 标 true 会让 UI 显示「可自动续期」——那是不实承诺。
                    refreshable: false,
                    createdAt: Date.now(),
                });
                return done({ accountId: id, existed: false });
            }
            case 'opencode.addAnonymous': {
                // 匿名通道 = 池里一条 api_key 为 `public` 的**普通条目**。
                // ⚠️ 与账号槽走完全相同的账号池机制（排序/停用/删除/代理/指纹代次），
                // 只是凭据不同 —— 这正是「多条匿名通道各走各的出口」的实现点。
                //
                // ⚠️ 指纹**不增加配额**：匿名通道按出口 IP 限额（实测：换 key、
                // 换伪装头、换指纹全部无效）。用户要多份额度必须给不同匿名通道
                // 配不同代理；指纹分离的价值是防关联。面板文案按此口径。
                const req = call.payload;
                const id = `${OPENCODE.id}-anon-${randomBytes(3).toString('hex')}`;
                const refName = `OPENCODE_ANON_${randomBytes(4).toString('hex').toUpperCase()}`;
                const count = pool.listAccountsByProvider(OPENCODE.id)
                    .filter((a) => a.id.startsWith(`${OPENCODE.id}-anon-`)).length;
                const nickname = typeof req?.nickname === 'string' && req.nickname.trim().length > 0
                    ? req.nickname.trim()
                    : `匿名通道 ${count + 1}`;
                await ctx.credentials.set(credentialRef(refName), JSON.stringify({
                    api_key: OPENCODE.anonymousKey,
                    nickname,
                }));
                await pool.addAccount({
                    id,
                    provider: OPENCODE.id,
                    nickname,
                    enabled: true,
                    credentialRef: refName,
                    refreshable: false,
                    createdAt: Date.now(),
                });
                return done({ accountId: id, existed: false });
            }
            case 'opencode.setProxy': {
                const req = call.payload;
                if (typeof req?.accountId !== 'string' || req.accountId.length === 0) {
                    return fail('缺少 accountId');
                }
                const raw = typeof req.proxy === 'string' ? req.proxy : '';
                if (raw.trim().length === 0) {
                    // 空串 = 清除：账号回到「与其它无代理账号共享本机出口」。
                    await pool.setOpencodeProxy(req.accountId, '');
                    return done({ proxy: '', label: '直连（本机出口）' });
                }
                const normalized = normalizeProxy(raw);
                if (!normalized.ok)
                    return fail(normalized.reason);
                await pool.setOpencodeProxy(req.accountId, normalized.proxy.url);
                return done({ proxy: normalized.proxy.url, label: normalized.proxy.label });
            }
            case 'opencode.testProxy': {
                const req = call.payload;
                const normalized = normalizeProxy(typeof req?.proxy === 'string' ? req.proxy : '');
                if (!normalized.ok)
                    return fail(normalized.reason);
                const startedAt = Date.now();
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
                try {
                    // ⚠️ 必须走 `proxyFetch`（与 dispatcher 同源的 fetch）：用全局
                    // fetch 会在 Node 22/24 上恒抛 `UND_ERR_INVALID_ARG`，正是缺陷
                    // IKK4BY 的现象。详见 `opencode-proxy.ts` 的 `proxyFetch`。
                    const response = await proxyFetch(EXIT_IP_URL, { signal: controller.signal }, normalized.proxy);
                    if (!response.ok)
                        return fail(`测试失败：代理返回 HTTP ${response.status}`);
                    const body = (await response.json());
                    if (body.status !== 'success' || typeof body.query !== 'string') {
                        return fail('测试失败：代理未能返回出口 IP（可能被目标站点拒绝）');
                    }
                    return done({
                        exitIp: body.query,
                        country: body.country ?? '',
                        latencyMs: Date.now() - startedAt,
                    });
                }
                catch (error) {
                    // ⚠️ **必须把 `cause` 带出来**（issue IKK4BY 第 2 点）：Node 的
                    // fetch 失败时 `error.message` **恒为** `fetch failed`，真正原因
                    // （DNS / 连接被拒 / TLS / 契约冲突 …）只挂在 `error.cause` 上。
                    // 只取 message 会让所有故障都显示成一句无信息量的 `fetch failed`，
                    // 用户与排障者都无从下手 —— 本 issue 的报障正是这个形态。
                    const message = describeFetchError(error);
                    return fail(`测试失败：${controller.signal.aborted ? '连接超时' : message}`);
                }
                finally {
                    clearTimeout(timer);
                }
            }
            case 'opencode.rotateFingerprint': {
                const req = call.payload;
                if (typeof req?.accountId !== 'string' || req.accountId.length === 0) {
                    return fail('缺少 accountId');
                }
                const current = pool.opencodeFingerprintGenerationFor(req.accountId);
                // ⚠️ 用**当前代次**派生下一代的 projectId，接线层再按
                // `deriveProjectId(api_key, generation)` 用池里的代次重算权威值。
                // 这里返回的 projectId 只用于 UI 即时回显，不作为请求依据。
                const next = nextFingerprintGeneration({ projectId: current === 0 ? 'anonymous' : String(current), generation: current });
                await pool.updateOpencodeFingerprintGeneration(req.accountId, next.generation);
                return done({ generation: next.generation, projectId: next.projectId });
            }
            default:
                // ⚠️ 返回 `undefined`（不是错误信封）：方法不属于 opencode，
                // 让主 switch 继续匹配 —— 它自己的 `default` 会给出
                // `unknown method`，那才是准确的归属。
                return undefined;
        }
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}
//# sourceMappingURL=opencode-rpc.js.map