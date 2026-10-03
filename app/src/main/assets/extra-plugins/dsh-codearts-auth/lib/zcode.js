/**
 * ZCode 凭据读取（**纯 Node，不需要 ZCode 实例运行**）。
 *
 * ## 为什么不再用「本机 HTTP 桥」
 *
 * PR #17 初版的设计是「读 `<dataBaseDir>/.zcode/v2/bridge-port.json` → 打本机桥
 * → 由 ZCode 实例代发上游」。那条路有一个致命的可用性问题（实测）：
 *
 * **它依赖一个被补丁注入过的开源版实例。** 官方闭源版
 * （`%LOCALAPPDATA%\Programs\ZCode\ZCode.exe`）**不写** `bridge-port.json`
 * —— 故「装了 ZCode」并不等于「桥可用」。而现实中用户装的正是官方版。
 *
 * 更关键的是，上游准入**并不真的需要 Electron**：
 *
 * - captcha 是阿里云的**网页 SDK**（`o.alicdn.com/captcha-frontend/...`），
 *   只需「一个有 DOM 的浏览器」—— 不需要 ZCode 那个壳；
 * - 3012 的判据是**请求体内容**（system 身份块 + 首轮 user 的
 *   `<system-reminder>` 日期块），与运行时无关 —— 上游实测 curl 同样 200。
 *
 * 而凭据本身就躺在磁盘上，官方用一套**公开可复现**的算法加密：
 * `enc:v1:` + AES-256-GCM + `sha256(secret)` 密钥，secret 缺省由
 * `平台 + 家目录 + 用户名` 派生。故纯 Node 即可解密（实测 7 个键全部成功）。
 *
 * ## 与 `AGENTS.md` 既有约定一致
 *
 * 「靠『文件实际在哪』这个事实探测，比靠『进程记得什么』可靠」——
 * 这里读的是**磁盘上的凭据文件**，不依赖任何进程是否在跑。
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { join } from 'node:path';
/** 密文前缀；无此前缀的值视为明文（官方实现同样如此）。 */
export const CREDENTIAL_PREFIX = 'enc:v1:';
/** 加密算法（官方 `createCredentialCipherProvider`）。 */
const CREDENTIAL_ALGO = 'aes-256-gcm';
/** IV 长度（字节）。 */
const CREDENTIAL_IV_LEN = 12;
/** AuthTag 长度（字节）。 */
const CREDENTIAL_TAG_LEN = 16;
/** 覆盖密钥的环境变量（官方同名）。 */
export const CREDENTIAL_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';
/**
 * `credentials.json` 的候选位置（按优先级）。
 *
 * ⚠ 与初版 `bridgeDiscoveryCandidates()` 的区别：**不再扫盘**。
 * 初版为找 `bridge-port.json` 会遍历每个盘符的顶层目录（实测 82 个候选、
 * 每次请求约 3ms），因为发现文件可能落在自定义路径（`<项目>\_oss_data`）。
 * 而 `credentials.json` 的位置由**官方固定**：写在
 * `<dataBaseDir>/.zcode/v2/` 下，默认 `dataBaseDir` 就是家目录。
 * 故只需少量确定候选 —— 这让「每次请求重读」的成本可忽略。
 */
export function credentialFileCandidates() {
    const out = [];
    const push = (dir) => {
        if (typeof dir !== 'string' || dir.trim().length === 0)
            return;
        const candidate = join(dir.trim(), '.zcode', 'v2', 'credentials.json');
        if (!out.includes(candidate))
            out.push(candidate);
    };
    // ① 显式数据根目录（支持 `;` 分隔多目录）—— 官方读同一个变量。
    const fromEnv = process.env.ZCODE_DATA_BASE_DIR;
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
        for (const dir of fromEnv.split(';'))
            push(dir);
    }
    // ② 家目录（官方默认：dataBaseDir = homedir，其下有 .zcode）。
    push(homedir());
    /**
     * ③ `%APPDATA%` / `%LOCALAPPDATA%`。
     *
     * 实测本机凭据在 `~/.zcode/v2/`，但官方部分安装形态用
     * `%APPDATA%\ZCode` 作 userData —— 两个都试，代价只是一次 stat。
     */
    push(process.env.APPDATA);
    push(process.env.LOCALAPPDATA);
    return out;
}
/** 定位实际存在的凭据文件；都找不到时返回首选路径（供报错信息用）。 */
export function resolveCredentialFilePath() {
    const candidates = credentialFileCandidates();
    for (const path of candidates) {
        try {
            if (existsSync(path))
                return path;
        }
        catch {
            // 权限/路径异常视为该候选不可用。
        }
    }
    return candidates[0] ?? join(homedir(), '.zcode', 'v2', 'credentials.json');
}
/** 读磁盘上的原始凭据表（`键 → 密文或明文`）。失败返回 undefined。 */
export function readRawCredentials(filePath = resolveCredentialFilePath()) {
    try {
        if (!existsSync(filePath))
            return undefined;
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return undefined;
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string')
                out[key] = value;
        }
        return out;
    }
    catch {
        return undefined;
    }
}
/**
 * 派生解密密钥（官方 `defaultCredentialSecret` + `deriveCipherKey`）。
 *
 * ⚠ 逐字复刻官方算法，**不要"规范化"**：
 * - 平台用 `process.platform` 原值（`win32` / `darwin` / `linux`）
 * - 用户名取值失败时回落**字面量** `unknown`
 * - 三段用 `:` 连接，前缀是 `zcode-credential-fallback`
 *
 * 任一处不同都会解出垃圾（GCM 认证失败），表现为「凭据读不出来」。
 */
export function deriveCredentialKey(env = process.env) {
    const explicit = env[CREDENTIAL_SECRET_ENV];
    if (typeof explicit === 'string' && explicit.length > 0) {
        return createHash('sha256').update(explicit).digest();
    }
    let username = 'unknown';
    try {
        username = userInfo().username;
    }
    catch {
        // 官方同样吞掉异常并回落 "unknown"。
    }
    const secret = `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
    return createHash('sha256').update(secret).digest();
}
/**
 * 解密一个凭据值。
 *
 * 无 `enc:v1:` 前缀时**原样返回**（官方 `decrypt()` 行为）——
 * 这让该函数对「用户手工填入明文」也成立。
 *
 * @throws 密文格式非法 / 密钥不匹配 / GCM 认证失败
 */
export function decryptCredentialValue(value, env = process.env) {
    if (!value.startsWith(CREDENTIAL_PREFIX))
        return value;
    const parts = value.slice(CREDENTIAL_PREFIX.length).split('.');
    if (parts.length !== 3)
        throw new Error('凭据密文格式非法（应为 iv.tag.data 三段）');
    const [ivPart, tagPart, dataPart] = parts;
    if (ivPart.length === 0 || tagPart.length === 0 || dataPart.length === 0) {
        throw new Error('凭据密文格式非法（存在空段）');
    }
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const data = Buffer.from(dataPart, 'base64url');
    if (iv.length !== CREDENTIAL_IV_LEN) {
        throw new Error(`凭据 IV 长度非法（${iv.length} ≠ ${CREDENTIAL_IV_LEN}）`);
    }
    if (tag.length !== CREDENTIAL_TAG_LEN) {
        throw new Error(`凭据 AuthTag 长度非法（${tag.length} ≠ ${CREDENTIAL_TAG_LEN}）`);
    }
    const decipher = createDecipheriv(CREDENTIAL_ALGO, deriveCredentialKey(env), iv);
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    }
    catch (error) {
        throw new Error(`凭据解密失败（密钥不匹配或密文损坏）：${error instanceof Error ? error.message : String(error)}`);
    }
}
/** 凭据键的匹配片段（官方键名很长且含 uuid，故用片段匹配）。 */
const KEY_FRAGMENTS = {
    jwt: 'zcodejwttoken',
    bigmodelAccess: 'oauth:bigmodel:access_token',
    codingPlanZai: 'zai-individual-coding-plan',
    codingPlanBigmodel: 'bigmodel-individual-coding-plan',
    userInfo: 'oauth:bigmodel:user_info',
};
/** 在凭据表里按键名**片段**查找并解密。 */
function pickCredential(table, fragment, env) {
    for (const [key, value] of Object.entries(table)) {
        if (!key.includes(fragment))
            continue;
        try {
            const plain = decryptCredentialValue(value, env);
            if (plain.length > 0)
                return plain;
        }
        catch {
            // 单个键解不开不影响其它键（例如某键用了不同的 secret）。
        }
    }
    return undefined;
}
/** 从 userInfo 里提取展示名（手机号末 4 位 / 用户名 / id 末 6 位）。 */
export function labelFromUserInfo(raw) {
    if (raw === undefined)
        return undefined;
    try {
        const info = JSON.parse(raw);
        for (const field of ['phone', 'mobile', 'name', 'nickname', 'email']) {
            const value = info[field];
            if (typeof value === 'string' && value.trim().length > 0) {
                const text = value.trim();
                // 手机号只留末 4 位（与其余 provider 的脱敏惯例一致）。
                if (/^\d{7,}$/.test(text))
                    return `尾号${text.slice(-4)}`;
                return text.length > 24 ? text.slice(0, 24) : text;
            }
        }
        const id = info['id'] ?? info['userId'];
        if (typeof id === 'string' && id.length >= 6)
            return `id:${id.slice(-6)}`;
    }
    catch {
        // userInfo 不是 JSON —— 忽略。
    }
    return undefined;
}
/** 手机号：11 位、以 1 开头、第 2 位 3-9（中国大陆移动号段）。 */
const PHONE_RE = /^1[3-9]\d{9}$/;
/**
 * 从 17 位 `user_id` 派生脱敏手机号，取不到返回 `undefined`。
 *
 * ## ⚠ 为什么要「派生」而不是「读取」
 *
 * 上游**不下发**手机号字段。实测：
 *
 * - `user_info` 的顶层键只有 `{id, username, displayName, rawProfile}`；
 * - `zcodejwttoken` 的 payload 只有 `{user_id, token_version, sub, iat}`；
 * - `oauth:bigmodel:access_token` 的 payload 只有 `{user_type, user_channel,
 *   user_id, user_key, customer_id, username}`；
 * - 扫遍 `~/.zcode/v2/{credentials,provider_config,telemetry-state,
 *   onboarding-record}.json`，**唯一**命中 11 位手机号形状的字符串就是
 *   `user_info.id` 的**前 11 位**（`onboarding-record.json` 的
 *   `decisions[0].userId` 是同一个 17 位值）。
 *
 * ⇒ 智谱把手机号编进了 `user_id` 的前缀。故这里取前 11 位校验后脱敏；
 * **校验不过就不显示**（有些账号的 id 前缀并非手机号，不能硬套）。
 */
export function phoneFromUserId(userId) {
    if (typeof userId !== 'string' || userId.length < 11)
        return undefined;
    const head = userId.slice(0, 11);
    if (!PHONE_RE.test(head))
        return undefined;
    return `${head.slice(0, 3)}****${head.slice(-4)}`;
}
/**
 * 从 `userInfo` 里取账号名与手机号。
 *
 * ## 账号名的取值顺序（三条来源必须都认）
 *
 * | 顺序 | 键 | 谁写的 |
 * |---|---|---|
 * | ① | `displayName` | 官方客户端的 `oauth:bigmodel:user_info`（实测用户名在这里） |
 * | ② | `username` | 同上（与 `displayName` 同值） |
 * | ③ | `rawProfile.name` | 官方客户端的嵌套副本 |
 *
 * ⚠ **刻意不取 `name` 顶层键** —— 那是 `labelFromUserInfo` 的判据，两处若用同一
 * 判据就没必要分开存了；且本机 `user_info` 根本没有顶层 `name`。
 *
 * ⚠ 与 `labelFromUserInfo` **并存**而不是替换它：后者被
 * `tests/unit/zcode.spec.ts:143-148` 逐字断言，且仍作为 `account_label` 的兜底。
 */
export function identityFromUserInfo(raw) {
    if (raw === undefined)
        return {};
    try {
        const info = JSON.parse(raw);
        const rawProfile = (typeof info['rawProfile'] === 'object' && info['rawProfile'] !== null)
            ? info['rawProfile']
            : {};
        let accountName;
        for (const value of [info['displayName'], info['username'], rawProfile['name']]) {
            if (typeof value === 'string' && value.trim().length > 0) {
                const text = value.trim();
                accountName = text.length > 24 ? text.slice(0, 24) : text;
                break;
            }
        }
        // 17 位 id 优先，其次嵌套的 rawProfile.user_id（两者实测同值）。
        const id = info['id'] ?? rawProfile['user_id'];
        const phone = phoneFromUserId(typeof id === 'string' ? id : undefined);
        return {
            ...(accountName !== undefined ? { accountName } : {}),
            ...(phone !== undefined ? { phone } : {}),
        };
    }
    catch {
        // userInfo 不是 JSON —— 忽略。
        return {};
    }
}
/** `telemetry-state.json` 的候选位置（与凭据同目录，故同形）。 */
function telemetryFileCandidates() {
    const out = [];
    const push = (dir) => {
        if (typeof dir !== 'string' || dir.trim().length === 0)
            return;
        const candidate = join(dir.trim(), '.zcode', 'v2', 'telemetry-state.json');
        if (!out.includes(candidate))
            out.push(candidate);
    };
    const fromEnv = process.env.ZCODE_DATA_BASE_DIR;
    if (typeof fromEnv === 'string')
        for (const dir of fromEnv.split(';'))
            push(dir);
    push(homedir());
    push(process.env.APPDATA);
    return out;
}
/**
 * 读设备标识。
 *
 * ⚠ 缺它时上游对 `billing/*` 与推理端点一律回
 * `400 code 3001 parameter error`（实测）—— 故它是**准入门槛的一部分**。
 */
export function readDeviceMid() {
    for (const path of telemetryFileCandidates()) {
        try {
            if (!existsSync(path))
                continue;
            const parsed = JSON.parse(readFileSync(path, 'utf8'));
            if (typeof parsed.deviceMid === 'string' && parsed.deviceMid.trim().length > 0) {
                return parsed.deviceMid.trim();
            }
        }
        catch {
            // 换个候选。
        }
    }
    return undefined;
}
/** 兜底的客户端版本（探测失败时用）。 */
export const ZCODE_APP_VERSION_FALLBACK = '3.14.3';
/**
 * 探测已安装的 ZCode 客户端版本。
 *
 * 为什么需要：请求头 `X-ZCode-App-Version` 与实际安装版本一致更自然。
 * 取不到时用兜底值 —— **不让版本探测失败连带让 provider 不可用**
 * （版本只是一个头，不该成为硬依赖）。
 */
export function detectZcodeAppVersion() {
    const roots = [
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ZCode'),
        join(process.env.PROGRAMFILES ?? '', 'ZCode'),
        join(process.env['PROGRAMFILES(X86)'] ?? '', 'ZCode'),
    ];
    for (const root of roots) {
        try {
            if (!existsSync(join(root, 'ZCode.exe')))
                continue;
            const manifest = join(root, '.zcode-install-manifest');
            if (!existsSync(manifest))
                continue;
            const match = readFileSync(manifest, 'utf8').match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/);
            if (match?.[1] !== undefined)
                return match[1];
        }
        catch {
            // 忽略，试下一个候选。
        }
    }
    return ZCODE_APP_VERSION_FALLBACK;
}
/**
 * 读取**可用**的 ZCode 凭据（来源：官方客户端的凭据文件）。
 *
 * 返回 `undefined` 表示**没有可用的 ZCode 登录态**（凭据文件不存在、
 * 解不开、或缺关键字段）—— 调用方据此让 provider 整体隐藏，
 * 而不是抛错（抛错会在 DSH 界面上多一条 provider 失败记录）。
 *
 * ⚠ 这是**回退路径**。优先路径是 `ctx.credentials` 里的插件自存凭据
 * （见 `ZcodeAuth.current()`）—— 那条路让用户不必安装官方客户端。
 */
export function readZcodeCredential(env = process.env, filePath) {
    const table = readRawCredentials(filePath);
    if (table === undefined)
        return undefined;
    const jwt = pickCredential(table, KEY_FRAGMENTS.jwt, env);
    if (jwt === undefined)
        return undefined;
    const deviceMid = readDeviceMid();
    if (deviceMid === undefined)
        return undefined;
    const userInfo = pickCredential(table, KEY_FRAGMENTS.userInfo, env);
    const identity = identityFromUserInfo(userInfo);
    const userId = readUserIdFromUserInfo(userInfo);
    return {
        zcode_jwt: jwt,
        device_mid: deviceMid,
        bigmodel_access_token: pickCredential(table, KEY_FRAGMENTS.bigmodelAccess, env),
        coding_plan_key_zai: pickCredential(table, KEY_FRAGMENTS.codingPlanZai, env),
        coding_plan_key_bigmodel: pickCredential(table, KEY_FRAGMENTS.codingPlanBigmodel, env),
        account_label: labelFromUserInfo(userInfo) ?? `设备${deviceMid.slice(0, 8)}`,
        /**
         * ⚠ **这里曾经漏了 `user_id`**（真实缺口）：`user_info.id` / 其嵌套的
         * `rawProfile.user_id` 就是服务端下发的那 17 位账号标识，与插件登录路径
         * 写进 `user_id` 的是**同一个值**。
         *
         * 缺了它，「读官方客户端凭据」这条路的账号**无法参与去重** ——
         * `findAccountIdByIdentityField` 遇到没有 `user_id` 的条目会**跳过**
         * （见 `src/account-pool.ts:569`「缺失该字段 ⇒ 无法判断，跳过」），
         * 表现为：装了官方客户端并登录过，再点「添加账号」仍会多出一条重复账号。
         */
        ...(userId !== undefined ? { user_id: userId } : {}),
        ...(identity.accountName !== undefined ? { account_name: identity.accountName } : {}),
        ...(identity.phone !== undefined ? { phone: identity.phone } : {}),
        app_version: detectZcodeAppVersion(),
        // 标记来源，便于 UI 与排查区分「插件登录」与「读官方客户端」。
        source: 'ide',
    };
}
/** 从 `userInfo` 取那 17 位账号标识（顶层 `id`，回退 `rawProfile.user_id`）。 */ export function readUserIdFromUserInfo(raw) {
    if (raw === undefined)
        return undefined;
    try {
        const info = JSON.parse(raw);
        for (const value of [info['id'], info['userId']]) {
            if (typeof value === 'string' && value.trim().length > 0)
                return value.trim();
        }
        const rawProfile = info['rawProfile'];
        if (typeof rawProfile === 'object' && rawProfile !== null) {
            const nested = rawProfile['user_id'];
            if (typeof nested === 'string' && nested.trim().length > 0)
                return nested.trim();
        }
    }
    catch {
        // userInfo 不是 JSON —— 忽略。
    }
    return undefined;
}
/**
 * 从两个来源里挑一个可用凭据。
 *
 * 优先级：**插件自存 > 官方客户端凭据文件**。
 *
 * ## 为什么插件自存优先
 *
 * 「插件内登录」的目标是让用户**不装 ZCode 客户端也能用**。
 * 若反过来（官方优先），一个用户在插件里登录后，只要机器上碰巧有
 * 另一份（可能已失效的）官方凭据，就会被后者覆盖 —— 表现为
 * 「明明刚登录成功，却报凭据失效」。
 *
 * @param stored 插件自存的凭据（来自 `ctx.credentials`；已解析成对象）。
 */
export function resolveZcodeCredential(stored, env = process.env) {
    if (stored !== undefined && isUsableZcodeCredential(stored))
        return stored;
    return readZcodeCredential(env);
}
/**
 * 凭据是否「够用」。
 *
 * 判据是**上游真正需要的两个字段**：JWT 与 device_mid。
 * 其余（coding-plan key 等）都是可选的 —— 缺了只影响 ultra 通道。
 */
export function isUsableZcodeCredential(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    return typeof record.zcode_jwt === 'string' && record.zcode_jwt.length > 0
        && typeof record.device_mid === 'string' && record.device_mid.length > 0;
}
/**
 * 凭据是否过期 —— **恒为 `false`**。
 *
 * ZCode 凭据是静态的：JWT 的 payload 里**没有 `exp`**（实测只有
 * `{user_id, token_version, sub, iat}`）。真失效时上游回 401/1002，
 * 由适配器归为 AUTH 并提示用户重新登录 —— 不做本地猜测。
 *
 * 保留该函数是为了让适配器无条件调用（与其它 provider 同形），
 * 而不是到处写 `provider === 'zcode'` 的特例。
 */
export function isZcodeExpired(_credential) {
    return false;
}
/** ZCode 是否可续期 —— 见 {@link isZcodeExpired}，**否**。 */
export const ZCODE_REFRESHABLE = false;
//# sourceMappingURL=zcode.js.map