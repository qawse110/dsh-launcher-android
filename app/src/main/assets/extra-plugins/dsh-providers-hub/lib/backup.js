import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { providerOfAccountRef, sanitizeAccounts, sanitizePermanentLocks } from './jet-hub-store.js';
import { OPENCODE } from './opencode-product.js';
import { BACKUP_FORMAT, BACKUP_VERSION } from './types.js';
/** 备份文件格式校验失败。 */
export class BackupFormatError extends Error {
}
/**
 * 账号身份字段候选表 —— 逐 provider 通读凭据形状后定下的**并集**。
 *
 * | 字段 | 写在哪些 provider 的凭据里 | 出处 |
 * |---|---|---|
 * | `user_id` | `buddy` / `workbuddy` / `lobsterai` / `raccoon` / `zcode` | 各自的登录/续期写入点 |
 * | `uid` | `qoder` / `qodercn` / `trae` | 同上 |
 * | `userid` | `loomy`（讯飞用户 id，18 位数字串） | `LoomyCredential.userid` |
 * | `account_id` | `cline`（`usr-…`）/ `minimax` | 两个 `*Credential` 接口 |
 * | `access_key_id` | `codearts`（AK/SK + security_token，**没有** `access_token`） | `CodeArtsCredential.access_key_id` |
 * | `sub` | `gemini`（OIDC `sub`，21 位数字串） | `GeminiCredential.sub` |
 *
 * ⚠️ **只收「一账号一值」的稳定标识**：`access_token` / `refresh_token` 会轮换，
 * 拿它们判重会让同一个账号在续期后被判成新账号（凭据泄漏面也会变大）。
 * ⚠️ `expires_at` / `nickname` 之类更是与身份无关，不要顺手加。
 *
 * ⚠️ **`codearts` 必须用 `access_key_id`**（真实缺陷，独立审计实测证伪）：
 * 本机实测真实凭据的顶层字段是 `access_key_id` / `secret_access_key` /
 * `security_token` / `expires_at` / `refresh_token` / `code_verifier` /
 * `dpop_private_key_jwk` —— **上表其余字段一个都没有**。漏掉这一格时身份判重
 * 恒判不出，于是「同一个 codearts 号我已手登过」**必然**多出一条重复账号
 * （实测：`access_key_id` 相同的两条被判成不同账号、`accountsImported=1`）。
 * ⚠️ 字段名与 `src/service.ts` 的 `CODEARTS_EXPIRY_ACCESSORS.identityOf`
 * **同源**（那里也取 `access_key_id`）—— 改一处必须改另一处。
 *
 * ⚠️ **gemini 只收 `sub`、不收 `email`**（两者都在 `GeminiCredential` 里）：
 * `sub` 是 OIDC 的稳定主体标识（换邮箱、改昵称都不变），上游就是拿它当账号 id
 * 用的（`gemini-auth.ts` 的 `persistLogin` 返回 `{ accountId: credential.sub }`）；
 * 而 `email` 会随用户改邮箱而变 —— 拿它当身份会让**同一个账号在改邮箱后被判成
 * 新账号**，与「轮换令牌不得当身份」是同一类错误。
 * ⚠️ **`sub` 在本仓库只有 gemini 写在凭据顶层**（minimax 那个 `sub` 是从 JWT 里
 * 解出来的，不落顶层字段），故它不会让别的 provider 误命中。
 *
 * ## 为什么必须覆盖到每个 provider（而不是只认 `user_id` / `uid`）
 *
 * 判不出身份时判重会**静默退化成纯 `id` 比对**，而 `id` 由 `shortId()` 随机生成、
 * 第三方转换器给的又是确定性哈希 —— 同一个账号因此有两套 id。漏掉一个 provider
 * 的字段，就等于那个 provider 的「同一个号我已手登过」场景**必然**多出一条重复账号。
 *
 * ## ⚠️ 已知**无法判重**的 provider：`minimax`
 *
 * `minimax` 的凭据里**没有任何可用的账号级稳定标识**，故它的身份判重**必然失效**
 * （静默退化为纯 `id` 比对 ⇒ 「同一个 minimax 号我已手登过」会多出一条重复账号）。
 * 这是**已知限制**，不是遗漏 —— 登记在此以免将来有人以为「表里漏了一格」：
 *
 * - `account_id`：**表里有它，但对 minimax 恒判不出**。它由
 *   `minimax-oauth.ts` 的 `decodeJwtSub(accessToken)` 派生，而真实 `access_token`
 *   是 `mmoat_` 前缀、60 字符、**0 个点**（`src/minimax.ts` 的 `decodeJwtExpMs`
 *   注释明文记载）⇒ `decodeJwtSub` **恒返回 `undefined`** ⇒ `account_id` 恒缺。
 *   保留该字段只为兼容上游将来改发 JWT。
 * - 其余字段（`user_id` / `uid` / `userid` / `access_key_id` / `sub`）都不在
 *   `MinimaxCredential` 里；`scope` / `nickname` 都不是账号级唯一值。
 *
 * 若要真正支持 minimax 判重，需**另调一次服务端 userinfo 端点**取稳定标识
 * （属功能增强，不在本模块职责内）。
 *
 * ⚠️ **绝不基于它做安全判定**，它只是判重键。
 */
const IDENTITY_FIELDS = ['user_id', 'uid', 'userid', 'account_id', 'access_key_id', 'sub'];
/**
 * 从凭据 JSON 原文里取出**账号身份**，取不到返回 undefined。
 *
 * 用途是合并导入的第二层判重（见 {@link importBackup}）：`id` 由插件随机生成，
 * 跨来源不可靠，而身份字段是账号在服务端的真实标识（候选表见
 * {@link IDENTITY_FIELDS}）。
 *
 * ⚠️ **`opencode` 必须单独处理**（见下），它没有上表里任何一个字段。
 */
function identityKey(provider, rawCredential) {
    if (typeof rawCredential !== 'string' || rawCredential.length === 0)
        return undefined;
    try {
        const parsed = JSON.parse(rawCredential);
        for (const key of IDENTITY_FIELDS) {
            const value = parsed[key];
            if (typeof value === 'string' && value.length > 0)
                return `${provider}:${value}`;
        }
        // opencode 的凭据只有 `api_key`（`{api_key, nickname}`），没有上表里的任何字段，
        // 故单独认它，并单独加 `key:` 命名空间以免与上面那类值撞键。
        //
        // ⚠️ **匿名槽必须排除**：匿名通道的 api_key 恒为 `OPENCODE.anonymousKey`
        // （字面量 `public`，见 `src/opencode-auth.ts` 的 `listIdentitySlots` 注释）——
        // 全部匿名槽共用同一个值，拿它当身份会把「用户刻意加的多条匿名通道」判成
        // 同一账号而**拒绝导入**（上游明确把「多条匿名槽各走各的出口」当能力提供）。
        // 排除后匿名槽退回纯 `id` 判重 —— 它们本就无法互相区分，这是唯一正确口径。
        if (provider === OPENCODE.id) {
            const apiKey = parsed.api_key;
            if (typeof apiKey === 'string'
                && apiKey.length > 0
                && apiKey !== OPENCODE.anonymousKey) {
                return `${provider}:key:${apiKey}`;
            }
        }
    }
    catch {
        // 凭据坏掉的条目由后面的写入环节记 skipped，这里只需判不出身份。
    }
    return undefined;
}
/**
 * 收集当前账号池里全部账号的身份（`provider:user_id`）。
 *
 * 逐条 `resolve` 凭据 —— 代价是池里账号数次的存储读取，只在合并导入时发生一次。
 * 凭据缺失/损坏的账号直接跳过：它们本就判不出身份，不该因此让导入失败。
 */
async function collectAccountIdentities(accounts, credentials) {
    const identities = new Set();
    for (const entry of accounts) {
        try {
            const resolved = await credentials.resolve(credentialRef(entry.credentialRef));
            if (resolved === undefined)
                continue;
            const key = identityKey(entry.provider, resolved.value);
            if (key !== undefined)
                identities.add(key);
        }
        catch {
            // 单条读不到不影响其余账号的判重。
        }
    }
    return identities;
}
/**
 * 导出账号 + 凭据 + 模型黑名单。
 *
 * 逐账号读取凭据；单个账号凭据缺失/损坏只记入 {@link BackupExportResult.warnings}，
 * 不中断整体导出 —— 换版本迁移场景下宁可先导出能导出的，也不要让一个坏账号
 * 挡住整份备份。
 *
 * `options.accountIds` 给出时只打包这些账号（及其凭据），用于「单独导出某个
 * 账号」；模型黑名单与锁定表**仍是全量**（见 {@link BackupExportOptions}）。
 */
export async function exportBackup(pool, credentials, options = {}) {
    const state = pool.getStateSnapshot();
    const warnings = [];
    // 不传 / 传空数组 = 导出全部（空数组按「没指定」处理，避免静默导出 0 个账号
    // 这种「文件看着成功、其实空的」的诱导性缺陷）。
    const selected = options.accountIds !== undefined && options.accountIds.length > 0
        ? new Set(options.accountIds)
        : undefined;
    const accounts = selected === undefined
        ? state.accounts
        : state.accounts.filter((entry) => selected.has(entry.id));
    if (selected !== undefined) {
        // 请求了但池里不存在的 id 要显式告知：否则用户会拿到一个少了账号的
        // 文件却以为导出成功（账号可能刚被删除或 id 拼错）。
        const found = new Set(accounts.map((entry) => entry.id));
        for (const id of selected) {
            if (!found.has(id))
                warnings.push(`${id}: 账号不存在（已跳过）`);
        }
    }
    const exported = {};
    for (const entry of accounts) {
        try {
            const resolved = await credentials.resolve(credentialRef(entry.credentialRef));
            if (resolved === undefined) {
                warnings.push(`${entry.id}: 凭据未配置`);
            }
            else {
                exported[entry.credentialRef] = resolved.value;
            }
        }
        catch (error) {
            warnings.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // 锁定表从独立文档取（状态快照里没有它）。
    const locks = sanitizePermanentLocks(pool.permanentLocksSnapshot());
    return {
        payload: {
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            exportedAt: new Date().toISOString(),
            credentials: exported,
            accounts,
            disabledModels: state.disabledModels,
            // ⚠️⚠️ **本载荷刻意不含 `providerClosed`（供应商关闭意图）**
            //（Gitee issue IKP8OF 审计登记 —— 不是漏键，`getStateSnapshot()` 同样不导出它）。
            //
            // 两条理由：
            // ① **格式兼容**：加字段要抬 `BACKUP_VERSION`，而导入端对版本是**严格相等**
            //    （见下方 `record.version !== BACKUP_VERSION` 的分支）⇒ 抬版本会让
            //    老版本插件**完全无法导入**新备份（不是「忽略未知字段」，是整份拒绝）。
            //    为一个「丢失后果可逆」的开关付这个代价不划算。
            // ② **语义上它也不该被搬走**：关闭意图描述的是「**这台机器上这个 provider
            //    该不该出现**」，而备份的主要用途是换机 / 迁移账号。把 A 机器的关闭态
            //    带到 B 机器上，B 上那个 provider 会**静默消失**（选择器里一条模型都没有），
            //    用户会以为「导入后模型全丢了」—— 那是比「关闭态丢失」更糟的方向。
            //
            // ⇒ 如实登记的代价：**导入备份会让「整家关闭」态退化为「逐条关闭」**。
            //    目录不再变长时两者表现相同（派生判据仍报已关闭）；只有目录继续变长时
            //    新增模型会重新出现。用户重新点一次供应商开关即恢复。
            //    ⚠️ 这条代价**同机「导出 → 恢复」也会命中**（不是只有换机）。
            //    见 `AccountPool.replaceAll` 里 `providerClosedCache = {}` 的注释。
            // 权威表 + Loomy 兼容字段**同源**（老版本只读后者，缺了会看到
            // 「锁定悄悄失效」，而失效的后果是真把永久积分烧掉了）。
            permanentLocks: locks,
            loomyPermanentLocked: locks.loomy === true,
        },
        warnings,
    };
}
/**
 * 校验备份载荷的格式与版本；不合法时抛 {@link BackupFormatError}。
 *
 * 校验在前、写入在后：凭据与账号池都不可被错误格式的备份文件覆盖。
 */
export function assertBackupPayload(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new BackupFormatError('备份内容不是对象');
    }
    const record = value;
    if (record.format !== BACKUP_FORMAT) {
        throw new BackupFormatError(`不是 ${BACKUP_FORMAT} 备份文件（format=${String(record.format)}）`);
    }
    if (record.version !== BACKUP_VERSION) {
        throw new BackupFormatError(`不支持的备份版本：${String(record.version)}（当前支持 v${BACKUP_VERSION}）`);
    }
    if (typeof record.exportedAt !== 'string') {
        throw new BackupFormatError('备份缺少 exportedAt 字段');
    }
    if (typeof record.credentials !== 'object' || record.credentials === null || Array.isArray(record.credentials)) {
        throw new BackupFormatError('备份 credentials 字段无效');
    }
    if (!Array.isArray(record.accounts)) {
        throw new BackupFormatError('备份 accounts 字段无效');
    }
    // ⚠️ **元素校验只收「真正会抛错」的那两类**（真实缺陷，独立审计实测证伪）。
    //
    // 修复这个缺陷时我第一版写的是「任何非对象元素都硬拒」，但实测只有 **`null`**
    // 会在统计环节抛 `TypeError: Cannot read properties of null`：
    // `(1).expiresAt` / `('str').expiresAt` / `(true).expiresAt` 都**不抛**
    // （原始值取属性返回 `undefined`），`[]` 同理。
    //
    // 而「拒绝范围过宽」有真实代价：它**破坏** `sanitizeAccounts` 的文档化降级行为
    // （「坏条目丢弃而不是写进池里」）—— 一份混了一个 `1` 的旧备份，修复前能导入
    // 其余全部好账号，过宽校验下**一个都导不进来**。
    //
    // ⇒ 判据只拒 `null` 与数组（数组会被 `sanitizeAccounts` 丢弃，且它的
    // `expiresAt` 访问虽不抛、但语义上根本不是账号条目）。
    // 其余原始值放行，交给 `sanitizeAccounts` 按既有语义丢弃。
    //
    // ⚠️ 另一条更稳的修法是在统计环节用 `entry?.expiresAt` 容错 —— 那能兼容**任何**
    // 元素类型。这里选「收窄校验范围」是因为它同时保住了「校验在前、零副作用」的
    // 性质（`null` 若走到写入之后才抛，会出现「数据已落地却报失败」）。
    if (record.accounts.some((entry) => entry === null || Array.isArray(entry))) {
        throw new BackupFormatError('备份 accounts 含非法条目（不能是 null 或数组）');
    }
    if (typeof record.disabledModels !== 'object' || record.disabledModels === null || Array.isArray(record.disabledModels)) {
        throw new BackupFormatError('备份 disabledModels 字段无效');
    }
    // 可选字段：存在时必须是对象（老备份没有它）。数组要单独判 ——
    // `typeof [] === 'object'`，只判 object 会放过一份形状错误的锁定表。
    if (record.permanentLocks !== undefined
        && (typeof record.permanentLocks !== 'object' || Array.isArray(record.permanentLocks))) {
        throw new BackupFormatError('备份 permanentLocks 字段无效');
    }
}
/**
 * 从备份载荷里取出锁定表，并兼容**只有老字段**的备份。
 *
 * 三种情形必须区分清楚（判错会让用户「以为锁着、其实没锁」）：
 *
 * | 备份来源 | 返回 | 效果 |
 * |---|---|---|
 * | 有 `permanentLocks`（新版导出） | 该表（已过滤脏值） | 整体替换当前锁定状态 |
 * | 只有 `loomyPermanentLocked`（老版导出） | `{ loomy: true }` 或 `{}` | 恢复 Loomy 那一项；buddy 无从得知 → 空 |
 * | 两个都没有（更早的备份） | `undefined` | **保持当前值**，不误解锁 |
 *
 * ⚠️ 老字段为 `false` 时**也**返回 `{}`（而不是 `undefined`）：既然这份备份
 * 明确表达了「Loomy 未锁定」，导入后就该解锁 —— 与「无从得知」不同。
 */
function locksFromPayload(payload) {
    if (payload.permanentLocks !== undefined) {
        const locks = sanitizePermanentLocks(payload.permanentLocks);
        // 老字段是唯一权威时也要并进表：存在一份「只写了 loomyPermanentLocked
        // 却漏了表」的历史导出（本次改动上线前的版本），不能因为表为空就丢掉它。
        if (locks.loomy === undefined && payload.loomyPermanentLocked === true)
            locks.loomy = true;
        return locks;
    }
    if (typeof payload.loomyPermanentLocked === 'boolean') {
        return payload.loomyPermanentLocked ? { loomy: true } : {};
    }
    return undefined;
}
/**
 * 导入备份。
 *
 * ## 两种模式（`options.mode`）
 *
 * | 模式 | 语义 | 用于 |
 * |---|---|---|
 * | `replace`（默认） | **整体替换**账号池与模型黑名单，还原快照 | 「恢复」按钮，换 DSH 版本后整体迁移 |
 * | `merge` | **只追加**：按 id 判重，已存在的账号一律跳过；**不碰**模型黑名单与锁定表 | 「单独导入一个账号」，从别人的备份里挑账号加进来 |
 *
 * ## 与写入顺序有关的约定
 *
 * - **先写凭据、后写账号池**：账号池写入成功后门控（`hasLoggedInAccount`）
 *   与黑名单立即反映新状态；凭据写入中途失败（非法 ref 等）只跳过该条、
 *   不中断整体。
 * - ⚠️ **`merge` 模式只写「确实要新增的账号」所引用的凭据**。它绝不回写
 *   备份里其余凭据（含各 provider 的默认单凭据 ref）—— 那些 ref 可能已被
 *   当前机器上的账号使用，回写等于**覆盖现有账号的凭据**，与「只增加」矛盾。
 * - 非法/值类型错误的凭据 ref 会被跳过并记录 —— `credentialRef()` 对非法
 *   POSIX 标识符抛错，`set` 也可能因存储后端拒绝而失败，都不应中断整体导入。
 * - 账号条目由 `replaceAll` / `mergeAccounts` 内部归一化（丢弃坏条目），
 *   保证坏数据不会进池。
 */
export async function importBackup(credentials, pool, raw, options = {}) {
    assertBackupPayload(raw);
    const payload = raw;
    const mode = options.mode ?? 'replace';
    // 决定「本次真正要落地的账号」与「跳过的账号」。
    // merge 的四层判重：① 池里已有的 **id**；② 池里已有的**身份**（凭据里的
    // `user_id` / `uid` / `userid` / `account_id` / `access_key_id`，opencode 另有
    // `api_key`，见 {@link IDENTITY_FIELDS}）；③ 备份文件内部重复的 id（由
    // `sanitizeAccounts` 统一去重）；④ **`credentialRef` 已被本机别的账号占用**
    // （见下，这是唯一一条「写凭据」方向的守卫）。
    let importedAccounts = payload.accounts;
    const accountsSkipped = [];
    if (mode === 'merge') {
        const state = pool.getStateSnapshot();
        const existingIds = new Set(state.accounts.map((entry) => entry.id));
        // ⚠️ **仅按 id 判重是不够的**：插件自己登录时 `id` 由 `shortId()` **随机**
        // 生成（`buddy-a1b2c3d4`），而第三方转换来的 id 是**确定性哈希**。同一个人
        // 因此有两套 id，只比 id 会把他重复加进池里 —— 用户在「从别人的备份里挑
        // 账号」时，最常见的情形恰恰是「这个号我已经手登过了」。
        // 故再按凭据里的身份字段判重（它才是账号的真实身份）。
        const existingIdentities = await collectAccountIdentities(state.accounts, credentials);
        /**
         * ⚠️⚠️ **`credentialRef` → 占用它的本机账号 id**（真实缺陷，对抗审计实测证伪）。
         *
         * 前三层判重都只决定「**账号条目**要不要追加」，而凭据写入用的是**另一套键**
         * （`credentialRef`）—— 这一维原先**无人检查**。后果：备份里一条全新 id、
         * 全新身份的账号，只要它的 `credentialRef` 恰好等于本机**另一个**账号正在用的
         * ref，写入就会**静默覆盖本机那个账号的凭据**，与「只增加不覆盖」的承诺相反，
         * 也与 UI 文案（「同 id 的账号自动跳过、不会被覆盖」「现有账号…都不受影响」）不符。
         *
         * ⚠️ **客户端 `trimBackupPayload` 挡不住这条**：撞车的 ref 就在用户勾选的
         * 范围内，裁剪只解决「范围**外**」的 ref。故这道守卫必须在**写凭据之前**、
         * 在**宿主侧**做。
         *
         * 判据是「该 ref 是否被本机某个账号占用」，命中即**拒绝采纳该账号**（连账号
         * 条目一起跳过，而不是只跳过凭据）—— 否则会落下一个**没有凭据**的账号条目，
         * 它会让 provider 目录被门控隐藏、并让用户以为导入成功。
         */
        const refOwners = new Map();
        for (const entry of state.accounts) {
            // 同一 ref 被本机多条账号引用时保留**第一条**（与 `updateAccount` 等按 id
            // 查找只命中第一条的既有语义一致；正常池里不会出现这种数据）。
            if (!refOwners.has(entry.credentialRef))
                refOwners.set(entry.credentialRef, entry.id);
        }
        const accepted = [];
        /**
         * ⚠️⚠️ **候选序列必须用「不去重」的归一化**（真实缺陷，最终审计实测证伪）。
         *
         * `sanitizeAccounts` 会按 id 去重（保留**第一条**）。若在采纳循环**之前**就调它，
         * 会出现「同 id 的第二条因第一条被拒而永远没机会」的静默丢号：
         *
         * - 载荷 `[dup→refA, dup→refB]`，`refA` 被本机占用（第④层拒）、`refB` 空闲且
         *   身份全新（**本应被采纳**）；
         * - 入口去重只留第一条 ⇒ 第二条**根本进不了循环** ⇒ `accepted = []`；
         * - 而 `accountsSkipped` 的差集判据（`!acceptedIds.has(id)`）把 `dup` 报成
         *   「已跳过」，UI 渲染成「1 个账号已存在（已跳过，未覆盖）」—— **该账号从未
         *   存在过**（它不在池里）。
         *
         * ⇒ 去重语义必须是「同 id 只采纳**第一条可采纳**的条目」，而不是「同 id 只保留
         * 第一条候选」。故这里改用**只做字段清洗、不去重**的归一化，把「同 id」交给
         * 下面的循环用 `existingIds` / `acceptedIds` 判（那才是「是否已存在」的权威判据）。
         *
         * ⚠️ 归一化的其余职责（丢弃坏条目、过滤脏限流值）**必须保留** —— 这里仍调
         * `sanitizeAccounts` 的**单条**版本语义：用 `sanitizeAccounts([entry])[0]` 逐条清洗。
         * 不用「整批调一次」是因为那会连带去重。
         */
        const candidateIds = new Set();
        for (const rawEntry of payload.accounts) {
            // 逐条清洗：借 `sanitizeAccounts` 的字段校验与脏值过滤（传单元素数组即不去重）。
            const cleaned = sanitizeAccounts([rawEntry]);
            const entry = cleaned[0];
            if (entry === undefined)
                continue;
            if (existingIds.has(entry.id)) {
                /**
                 * ⚠️ **分两种情形，不能都报「已跳过」**（真实缺陷，最终审计实测证伪）：
                 *
                 * - 该 id **已在本批次被采纳**（`candidateIds` 命中）⇒ 本条只是文件内的
                 *   重复条目，**不是「账号已存在」**。若报进 `accountsSkipped`，同一个 id
                 *   会既出现在「新增」里又出现在「已跳过」里，UI 文案自相矛盾
                 *   （`jet-hub.js` 用 `accountsSkipped.length` 渲染「N 个账号已存在」）。
                 * - 该 id **真的在池里**（或在更早的轮次被拒）⇒ 才报「已跳过」。
                 */
                if (!candidateIds.has(entry.id) && !accountsSkipped.includes(entry.id)) {
                    accountsSkipped.push(entry.id);
                }
                continue;
            }
            const identity = identityKey(entry.provider, payload.credentials[entry.credentialRef]);
            if (identity !== undefined && existingIdentities.has(identity)) {
                if (!accountsSkipped.includes(entry.id))
                    accountsSkipped.push(entry.id);
                continue;
            }
            // ⚠️ 第 ④ 层：ref 已被本机别的账号占用 → 拒绝（写它会覆盖对方凭据）。
            // 注意这里比的是「占用者的 id 是否就是本条自己」——本条 id 已在第 ① 层
            // 被排除（它不在池里），故只要命中占用就必然**是别人**，直接跳过即可。
            // ⚠️ **本条被拒不影响同 id 的后续候选**（去重交给下面的登记，见上方注释）。
            const owner = refOwners.get(entry.credentialRef);
            if (owner !== undefined) {
                if (!accountsSkipped.includes(entry.id))
                    accountsSkipped.push(entry.id);
                continue;
            }
            /**
             * ⚠️ 第 ⑤ 层：**ref 的 provider 前缀必须与本条 `provider` 一致**。
             *
             * 账号 ref 的形态是 `{PREFIX}_ACCOUNT_{HEX}`，前缀与 provider 一一对应
             * （单一真相源在 `src/jet-hub-store.ts`）。若备份里一条 `provider: 'buddy'`
             * 的账号引用 `CODEARTS_ACCOUNT_XXX`，导入后 buddy 的适配器会去解析一份
             * **AK/SK 形状**的凭据（buddy 读 `access_token`，而 codearts 凭据里没有它）
             * ⇒ 该账号必然请求失败，且排障时会看到「凭据里没有 access_token」这种
             * 与 provider 对不上的怪现象。
             *
             * 判据用 `providerOfAccountRef`（与 `accountFromCredentialRef` 同源的正则 +
             * 同一张表），**不自己再写一份前缀映射**。
             *
             * ⚠️ 单凭据回退 ref（`BUDDY_ACCESS_TOKEN` 等）返回 `undefined` —— 它们不是
             * 账号 ref，此处**放行**（`merge` 只写被采纳账号引用的 ref，而账号引用单凭据
             * ref 是历史数据里真实存在的形态，不该因噎废食地拒绝整个账号）。
             */
            const refProvider = providerOfAccountRef(entry.credentialRef);
            if (refProvider !== undefined && refProvider !== entry.provider) {
                if (!accountsSkipped.includes(entry.id))
                    accountsSkipped.push(entry.id);
                continue;
            }
            // ⚠️ 登记「已采纳」：**这里是同 id 去重的唯一判据** —— 同 id 的后续候选会在
            // 下一轮第 ① 层被 `existingIds` 拦下（这就是「同 id 只采纳第一条**可采纳**
            // 的条目」的语义）。不要再依赖入口的 `sanitizeAccounts` 去重（那会静默丢号）。
            existingIds.add(entry.id);
            if (identity !== undefined)
                existingIdentities.add(identity);
            // 同批次内两条账号引用同一 ref 时，第二条也必须拒绝：否则它们会共用一份
            // 凭据（后写的赢），成为两个 id 指向同一份令牌的隐形别名。
            refOwners.set(entry.credentialRef, entry.id);
            accepted.push(entry);
            candidateIds.add(entry.id);
            /**
             * ⚠️ **采纳成功后必须回撤该 id 的「已跳过」记录**（真实缺陷，最终审计实测证伪）。
             *
             * 同 id 的**第一条**可能因 ref 撞车等原因被拒（那时已报进 `accountsSkipped`），
             * 而**第二条**随后被采纳。若不回撤，同一个 id 会**既出现在「新增」里、
             * 又出现在「已跳过」里** —— UI 用 `accountsSkipped.length` 渲染
             * 「N 个账号已存在（已跳过，未覆盖）」，而该账号其实刚被成功导入。
             *
             * 语义澄清：`accountsSkipped` 回答的是「哪些**账号**（按 id）没被采纳」，
             * 而一个 id 最终**被采纳了**就不再是「跳过」—— 文件里的重复条目本身
             * 不构成「已存在」，只是同一份数据被写了两遍。
             */
            const skippedIndex = accountsSkipped.indexOf(entry.id);
            if (skippedIndex !== -1)
                accountsSkipped.splice(skippedIndex, 1);
        }
        /**
         * ⚠️ **文件内部重复 id 的「报告」**（真实缺陷，独立审计实测证伪）。
         *
         * 采纳循环已按「同 id 只采纳第一条**可采纳**的条目」处理，故 `accountsSkipped`
         * 里可能**只有**第一条被拒的 id，而文件里还有同 id 的后续候选（它们同样未被采纳）
         * —— 但 `accountsSkipped` 的语义是「哪些**账号**被跳过了」，同一个 id 只该出现
         * 一次，故这里**不再补报**（用 `Set` 收敛已在循环内用 `includes` 完成）。
         *
         * ⚠️ 保留这段只为**兜底**一种情形：文件里同 id 的条目**全部**是坏条目
         * （被逐条清洗丢弃，从未进过循环）⇒ 循环里没报过 ⇒ 这里也不该报
         * （它们不是「账号」，只是垃圾数据）。故本段**刻意什么都不做**，
         * 仅保留 `candidateIds` 供调试与将来的提示字段使用。
         */
        void candidateIds;
        importedAccounts = accepted;
    }
    // merge 下只写被采纳账号的凭据；replace 下按字典逐条写（备份文件里可能含
    // 账号池之外的独立凭据 ref，如各 provider 的默认单凭据 ref，导出时一并纳入，
    // 导入时同样还原）。
    const credentialsToWrite = mode === 'merge'
        ? Object.fromEntries(importedAccounts
            .map((entry) => [entry.credentialRef, payload.credentials[entry.credentialRef]])
            .filter((pair) => pair[1] !== undefined))
        : payload.credentials;
    const skipped = [];
    let credentialsImported = 0;
    for (const [refName, value] of Object.entries(credentialsToWrite)) {
        if (typeof value !== 'string') {
            skipped.push(refName);
            continue;
        }
        try {
            await credentials.set(credentialRef(refName), value);
            credentialsImported++;
        }
        catch (error) {
            skipped.push(refName);
        }
    }
    if (mode === 'merge') {
        // 只追加：不传黑名单与锁定表，池会保持当前值。
        await pool.mergeAccounts(importedAccounts);
    }
    else {
        await pool.replaceAll(payload.accounts, payload.disabledModels, locksFromPayload(payload));
    }
    // 统计已过期账号：expiresAt 是毫秒时间戳，缺失或 NaN 视为「未知」不算过期。
    // ⚠️ 只统计**真正落地**的账号：merge 下把被跳过的账号也算进来会让提示虚高，
    // 而它们的凭据根本没被写。
    const now = Date.now();
    const expiredAccounts = importedAccounts.filter((entry) => typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) && entry.expiresAt <= now).length;
    // 统计凭据缺失账号：账号条目存在但其 credentialRef 不在 credentials 字典。
    // 注意导入时被 skipped 的 ref 也算「缺失」——它们确实没写进凭据存储。
    const skippedSet = new Set(skipped);
    const missingCredentials = importedAccounts.filter((entry) => !Object.prototype.hasOwnProperty.call(payload.credentials, entry.credentialRef)
        || skippedSet.has(entry.credentialRef)).length;
    return {
        credentialsImported,
        // replace 保留既有口径（备份里的条目数，含非法条目），避免改变既有行为；
        // merge 报**实际新增**数，因为这才是用户关心的「加了几个」。
        accountsImported: mode === 'merge' ? importedAccounts.length : payload.accounts.length,
        accountsSkipped,
        skipped,
        expiredAccounts,
        missingCredentials,
    };
}
//# sourceMappingURL=backup.js.map