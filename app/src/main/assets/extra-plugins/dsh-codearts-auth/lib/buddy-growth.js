/**
 * CodeBuddy 成长中心任务自动化。
 *
 * 借鉴自 WorkDaddy 的 `growth-daily.js`（AGPL）重写，只保留**纯 API 内核**：
 * 任务接取 + 判据事件上报 + 逐项领奖。端点基址随 `product.endpoint`
 * （`copilot.tencent.com`）切换，鉴权复用 Jet Hub 的账号池 token（Bearer）。
 * WorkDaddy 里那套 CDP 注入、DOM 自动化、AI 刷活跃保连胜的引擎**不**搬运 ——
 * Jet Hub 没有客户端注入面，纯 API 层才是可移植部分。
 *
 * 合规：端点契约参考 WorkBuddy（AGPL-3.0）公开文档，本实现为独立重写，
 * 不复制其代码、构建产物或 CDP 引擎，不构成 AGPL 派生作品。
 *
 * 端点与格式来自对 WorkBuddy 5.5.x 成长中心的逆向 + 真实请求实测（2026-10-03）：
 *
 *   任务列表  GET  /v2/activity/growth/tasks            （v1: /activity/growth/tasks）
 *   任务接取  POST /activity/growth/tasks/accept        body {task_codes:[…]}
 *   旅行状态  GET  /activity/growth/buddy/travel/status
 *   旅行领奖  POST /activity/growth/buddy/travel/claim  body {}
 *   遥测上报  POST /v2/report
 *   逐项领奖  POST {claimBase}/activity/growth/tasks/<task_code>/claim
 *
 * 两个关键结论（实测）：
 *
 * 1. **幂等/无对象判定以响应体 code + msg 为准**，不能只看 HTTP 状态。
 *    不可领状态是 HTTP 400 + code 400 + msg（"no unclaimed travel" /
 *    "insufficient energy" / "please accept buddy adoption agreement first"），
 *    与签到端点的 10001 同型 —— 只看状态码会把「没有可领对象」误报为失败。
 *
 * 2. **任务接取（accept）本身不加积分**，它把任务从 `not_accepted` 置为
 *    `in_progress`；积分在任务**完成后**由服务端发放（`reward_credit`/
 *    `reward_energy`）。故本模块的默认（`runExotic:false`）只做**低副作用**动作：
 *    接取白名单任务 + 旅行领奖。盲盒/抽奖/首Buddy 是**有代价/一次性**动作，
 *    默认关闭，经 `runExotic` 显式开启。
 */
import { createHash } from 'node:crypto';
import { BUDDY_DEPLOYMENT_TYPE, HTTP_HEADER_DOMAIN, HTTP_HEADER_PRODUCT, HTTP_HEADER_PRODUCT_CODE, } from './buddy.js';
/**
 * 判据事件里必须出现的固定资源 id。这些是**服务端判据绑定的具体资源**，
 * 换掉就不计数，因此不是可调参数；但写成裸字面量会让「这是真实资源 id」
 * 与「这是拼写错误」无法区分，故在此具名。
 *
 * - BUDDY_APP_ID：应用类判据只认 buddyId。Buddy_App 与 Buddy_App_QQ 判据同源。
 * - LIGHTHOUSE_EXPERT_ID：Expert_lighthouse 绑定固定专家，市场里任取专家不计数。
 *   该专家为腾讯轻量云专家，id 取自实测可达的专家市场列表。
 */
const BUDDY_APP_ID = 'cb_y5Dy46tPQGGWtueMxXbe';
const LIGHTHOUSE_EXPERT_ID = 'ex_2cvvUZQhDyeJ';
const LIGHTHOUSE_EXPERT_NAME = '腾讯轻量云专家';
/** `Hp_Appearance` 判据绑定的主题资源 key。 */
const APPEARANCE_THEME_KEY = 'theme-tkmw7j';
/** `Library_read` 判据绑定的资料库空间文档 id。 */
const LIBRARY_SPACE_DOC_ID = 'o0KWYeynteVv06UnAZqIFm';
/** `skill_1` / `skill_installed` 判据绑定的技能 id。 */
const SKILL_ID = 'skill_2097350077599879168';
/** 通用对话链使用的真实模型 id（非 `default-model` 虚拟路由别名）。 */
const DEFAULT_CHAT_MODEL = 'deepseek-v4.1-flash';
/** 快速模型：等级族与技能类判据只认它。 */
const FAST_MODEL = 'fast-model';
/** `Model_chat_GLM5.2` 判据绑定的模型 id 与模型名（**大小写不同**，同值不计数）。 */
const GLM_MODEL_ID = 'glm-5.2';
const GLM_MODEL_NAME = 'GLM-5.2';
/** 任务列表查询端点（v2 主、v1 回退，二者都 200）。 */
export const GROWTH_TASKS_PATHS = ['/v2/activity/growth/tasks', '/activity/growth/tasks'];
/** 任务接取端点。 */
export const GROWTH_TASK_ACCEPT_PATH = '/activity/growth/tasks/accept';
/** 旅行状态查询端点。 */
export const GROWTH_TRAVEL_STATUS_PATH = '/activity/growth/buddy/travel/status';
/** 旅行领奖端点。 */
export const GROWTH_TRAVEL_CLAIM_PATH = '/activity/growth/buddy/travel/claim';
/** 首个 Buddy 解锁端点（一次性动作，默认不执行）。 */
export const GROWTH_FIRST_BUDDY_PATH = '/activity/growth/buddy/first';
/** 盲盒端点（消耗 energy，默认不执行）。 */
export const GROWTH_BLIND_BOX_PATH = '/v2/activity/growth/buddy/open';
/** 抽奖端点（消耗 lottery 次数，默认不执行）。 */
export const GROWTH_LOTTERY_PATH = '/v2/activity/growth/lottery/draw';
/**
 * 可自动接取的任务白名单（task_code）。
 *
 * 只接取**纯使用即可达成**、且奖励为普通 credit/energy 的任务。限定款
 * （`reward_buddy:true`、需下载桌面端/升级主题解锁的盲盒 Buddy）**不**进默认白名单，
 * 避免误触发一次性解锁动作。判据与 WorkDaddy `AUTOMATABLE_TASK_CODES` 对齐。
 */
export const AUTOMATABLE_TASK_CODES = new Set([
    'create_canvas', 'template_5', 'expert_5', 'Expert_team_use_3',
    'automation_1', 'playbook_prompt', 'Expert_lighthouse', 'Buddy_App',
    'Buddy_App_QQ', 'Hp_Appearance', 'chat_5', 'Model_chat_GLM5.2',
    // 「养虾等级」任务族
    'first_chat', 'template_used', 'expert_summoned', 'skill_installed', 'wechat_linked',
    'black_cat', 'Library_read', 'RichMeow_Chat', 'skill_1',
    'wb_wechat_oa_subscribe_task',
]);
/** 请求超时（毫秒）。与签到同款口径，单请求 30s。 */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * 「没有可领对象」类的业务码。成长端点把这类情况统一回 HTTP 400 + code 400，
 * 靠 msg 文案区分具体原因（无未领旅行 / 能量不足 / 未签 Buddy 采纳协议）。
 * 与签到端点 10001 同型：判定以响应体 code + msg 为准。
 */
const GROWTH_NO_OBJECT_CODE = 400;
/**
 * 各平台 `osVersion` 的取值。**必须与 `os` 同平台** —— 此前非 darwin 一律写
 * `10.0.26220`（Windows 版本号），于是 Linux 宿主上报 `os: 'linux'` 配一个
 * Windows 版本号，自相矛盾。
 */
const PLATFORM_OS_VERSIONS = {
    darwin: '15.0',
    win32: '10.0.26220',
    linux: '6.8.0',
};
/**
 * Node 的 `process.platform` → 浏览器 `navigator.platform` 取值。
 *
 * 两个域对同一个操作系统的**命名不同**（桌面域说 `win32`、web 域说 `Win32`），
 * 但描述的是同一台机器，故各自按本域习惯命名、而 `arch` 与 `osVersion` 保持一致。
 *
 * ⚠️ 这些值是**基线**：`arch` 明确时由 {@link webOsName} 按架构细化。
 * 原先 linux 恒写 `'Linux x86_64'`，于是 arm64 宿主上报
 * `os: 'Linux x86_64'` 配 `arch: 'arm64'` —— 同一对象里自相矛盾
 * （与「非 darwin 一律写 Windows 版本号」是同一类缺陷）。
 */
const WEB_OS_NAMES = {
    darwin: 'MacIntel',
    win32: 'Win32',
    linux: 'Linux x86_64',
};
/** `process.arch` → `navigator.platform` 里的架构后缀（仅 linux 需要区分）。 */
const WEB_ARCH_SUFFIXES = {
    x64: 'x86_64',
    arm64: 'aarch64',
    ia32: 'i686',
};
/**
 * web 域的 `navigator.platform` 取值。
 *
 * linux 下按真实架构拼后缀，避免 `os` 与 `arch` 在一个对象里互相矛盾
 * （浏览器在 linux 上就是报 `Linux x86_64` / `Linux aarch64` 这种形态）。
 */
function webOsName(os, arch) {
    if (os === 'linux') {
        const suffix = WEB_ARCH_SUFFIXES[arch];
        return suffix === undefined ? WEB_OS_NAMES['linux'] : `Linux ${suffix}`;
    }
    return WEB_OS_NAMES[os] ?? os;
}
/** 桌面域平台身份。`os` 用 Node 原值，`arch` 用 `process.arch`（不写死 x64）。 */
function platformIdentity() {
    const os = process.platform;
    return {
        os,
        arch: process.arch,
        osVersion: PLATFORM_OS_VERSIONS[os] ?? '0.0.0',
    };
}
/** web 域平台身份：同一台机器，按浏览器习惯重命名 `os`。 */
function webPlatformIdentity() {
    const identity = platformIdentity();
    // `os` 按架构细化（linux 的 x86_64/aarch64），`arch` 与 `osVersion` 原样保留 ——
    // 同一台机器在两个域只能命名不同，不能描述不同。
    return { ...identity, os: webOsName(identity.os, identity.arch) };
}
/** 单账号时间预算缺省值（毫秒）。实测单账号 90～270s，10 分钟够 3～4 项从容跑完。 */
const DEFAULT_BUDGET_MS = 600_000;
/** 任务间隔节流（毫秒）。 */
const TASK_INTERVAL_MS = 1500;
/** 同任务多轮上报之间的节流（毫秒）。 */
const ROUND_INTERVAL_MS = 1000;
/** 扫尾补领每项之间的节流（毫秒）。 */
const SWEEP_INTERVAL_MS = 1000;
/** 上报后等待服务端结算再复查 progress 的等待（毫秒）。 */
const SETTLE_WAIT_MS = 4000;
/** 主题写入后等皮肤事件生效的等待（毫秒）。 */
const APPEARANCE_SETTLE_MS = 2000;
/** 只带极简头的端点（会话族、上报族）共用的鉴权头。 */
function minimalHeaders(credential, product) {
    const headers = {
        Authorization: `Bearer ${credential.access_token}`,
        'Content-Type': 'application/json',
        'User-Agent': product.userAgent,
    };
    if (credential.user_id) {
        headers['X-User-Id'] = credential.user_id;
    }
    return headers;
}
/** 从 JSON 安全读取字符串。 */
function readString(source, key) {
    if (typeof source !== 'object' || source === null) {
        return '';
    }
    const value = source[key];
    return typeof value === 'string' ? value : '';
}
/** 从 JSON 安全读取数字（非有限或非数字归 0）。 */
function readNumber(source, key) {
    if (typeof source !== 'object' || source === null) {
        return 0;
    }
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/** 把端点基址尾斜杠去掉，避免拼出 `//`。 */
function baseOf(product) {
    return String(product.endpoint).replace(/\/+$/, '');
}
/**
 * web 域**领奖**基址，取 `product.claimBase`。缺字段时返回 `''`（调用方须判空）。
 *
 * ⚠️ **不能直接 `String(product.claimBase)`**：`String(undefined)` 得到的是
 * **字符串 `"undefined"`** 而非抛错 —— URL 会拼成
 * `undefined/activity/growth/tasks/<code>/claim`，请求真的发出去，失败现象看起来
 * 像服务端问题，真因（本插件缺配置）却毫无线索。这类「不崩但静默错」比崩溃更难查。
 * （感谢 contributor 在 !62 复审中指出，原文见该 PR 讨论。）
 */
function claimBaseOf(product) {
    const raw = typeof product.claimBase === 'string' ? product.claimBase.trim() : '';
    return raw.replace(/\/+$/, '');
}
/**
 * web 域**遥测上报**基址，取 `product.webBase`；未配置时退到 `claimBase`。
 *
 * ⚠️ 与 `claimBaseOf` **刻意分开**（见 `BuddyProduct.webBase` 的注释：领奖走
 * 产品 API 站、web 遥测走网页站，`Origin` / `Referer` 需各自独立配置）。
 * `webBase` 曾只定义不读取（死配置），此处是唯一读取点 —— 删字段前先确认这里。
 *
 * 回退顺序：`webBase` → `claimBase` → `''`（两站当前同主机，但取不到时宁可返回空
 * 让调用方报可读错误，也不要拼出 `undefined/...` 这种能发出去却指向本地缺配置的 URL）。
 */
function webBaseOf(product) {
    const explicit = typeof product.webBase === 'string' ? product.webBase.trim() : '';
    if (explicit.length > 0) {
        return explicit.replace(/\/+$/, '');
    }
    return claimBaseOf(product);
}
/** SHA-256 十六进制摘要。桌面/网页指纹的 machineId 与 sessionId 由此派生。 */
function sha256Hex(input) {
    return createHash('sha256').update(String(input)).digest('hex');
}
/** 构造成长中心请求头。与签到请求头（`credits.ts` 的 `checkinHeaders`）同款口径：
 * `X-Domain` 以**产品配置**为准而非凭据快照，避免国际版旧凭据把身份标识发错区域。
 * 额外带 `X-Client-Platform: web`（成长中心前端固定该头，签到端点不带）。 */
function growthHeaders(credential, product) {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${credential.access_token}`);
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    headers.set('X-Client-Platform', 'web');
    headers.set(HTTP_HEADER_DOMAIN, product.apiDomain || credential.domain || '');
    headers.set(HTTP_HEADER_PRODUCT, BUDDY_DEPLOYMENT_TYPE);
    headers.set(HTTP_HEADER_PRODUCT_CODE, product.productCode);
    if (credential.user_id !== undefined && credential.user_id.length > 0) {
        headers.set('X-User-Id', credential.user_id);
    }
    if (credential.enterprise_id !== undefined && credential.enterprise_id.length > 0) {
        headers.set('X-Enterprise-Id', credential.enterprise_id);
        headers.set('X-Tenant-Id', credential.enterprise_id);
    }
    headers.set('User-Agent', product.userAgent);
    return headers;
}
/**
 * 发起一次成长中心请求并解析 JSON。
 * 与签到同款：先取文本再解析，非 JSON（凭据失效的网关 HTML 页）时带上状态码，
 * 不把「凭据过期」压成 `Unexpected token '<'`。
 *
 * `method` 区分读/写：任务列表是 **GET**（POST 会 404），接取/领奖/盲盒/抽奖
 * 是 **POST**。默认 POST。
 */
async function growthJson(method, path, credential, product, body, fetcher) {
    try {
        const response = await fetcher(`${product.endpoint}${path}`, {
            method,
            headers: growthHeaders(credential, product),
            body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            return {
                ok: false,
                nonJson: true,
                status: response.status,
                message: describeNonJsonResponse(response.status, text),
            };
        }
        if (typeof parsed !== 'object' || parsed === null) {
            return { ok: false, status: response.status, message: '请求失败或响应无法解析' };
        }
        return { ok: true, status: response.status, body: parsed };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
/** 成长读端点（GET）请求。任务列表 / 旅行状态等。 */
function getGrowthJson(path, credential, product, fetcher) {
    return growthJson('GET', path, credential, product, undefined, fetcher);
}
/** 成长写端点（POST）请求。接取 / 领奖 / 盲盒 / 抽奖 / 首Buddy。 */
function postGrowthJson(path, credential, product, body, fetcher) {
    return growthJson('POST', path, credential, product, body, fetcher);
}
/** 把「响应不是 JSON」整理成可读原因（同签到端点口径）。 */
function describeNonJsonResponse(status, text) {
    if (status === 401 || status === 403) {
        return `凭据已失效（HTTP ${status}），请重新登录该账号`;
    }
    const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ');
    return `服务端返回了非 JSON 响应（HTTP ${status}）：${snippet}`;
}
/**
 * 「无对象」文案白名单（大小写不敏感的子串匹配）。
 *
 * ⚠️ **必须窄**：`code 400` 是成长端点表达多种语义的通用码 —— 它既表示
 * 「没有可领对象」（正常幂等终态），也表示 `task not completed`（任务真没做完）、
 * 参数错误等**真失败**。只认 code 会把后者一并归成「已领奖」，用户看到
 * 「已领到积分」而实际一分没有。
 *
 * 实测文案（2026-10-03）：
 * - `no unclaimed travel` —— 没有未领的旅行奖励
 * - `insufficient energy` —— 能量不足（盲盒/抽奖类）
 * - `please accept buddy adoption agreement first` —— 未签 Buddy 采纳协议
 *
 * ⚠️ 反向要求：白名单命中即**不再算失败**（归 `no-object` → `already-claimed`），
 * 故**宁可漏判不可误伤** —— 少了词条只会让某条正常终态被显示成失败（用户多点一次，
 * 无损害）；多了词条会把真失败谎报成成功（用户以为领到了）。这与本仓库
 * 「方向取保守」的总原则一致。
 */
const GROWTH_NO_OBJECT_MESSAGE_PATTERNS = [
    /no unclaimed travel/i,
    /insufficient energy/i,
    /accept buddy adoption agreement/i,
];
/** 该 msg 是否表示「没有可领对象」这一正常终态。 */
function isNoObjectMessage(message) {
    return GROWTH_NO_OBJECT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}
/**
 * 把一次成长写请求的响应归类为三类之一：
 * - `success`：code 0，返回 data（可能为空对象）。
 * - `no-object`：code 400 **且 msg 命中「无对象」文案**（无未领旅行/能量不足/未签协议）
 *   —— 这是**正常的幂等终态**，不是失败。
 * - `failed`：其余（含 code 400 但 msg 是 `task not completed` 这类真失败）。
 */
function classifyGrowthWrite(result) {
    if (!result.ok) {
        return { state: 'failed', message: result.message };
    }
    const body = result.body;
    const code = typeof body.code === 'number' ? body.code : -1;
    const message = readString(body, 'msg');
    if (code === 0) {
        const data = typeof body.data === 'object' && body.data !== null
            ? body.data
            : {};
        return { state: 'success', data };
    }
    // ⚠️ code 400 必须**同时**看 msg：见上面白名单的注释（此处曾把任何 code 400
    // 都当幂等终态，于是 `task not completed` 被谎报成「已领奖」）。
    if (code === GROWTH_NO_OBJECT_CODE && isNoObjectMessage(message)) {
        return { state: 'no-object', message };
    }
    return { state: 'failed', code, message: message.length > 0 ? message : '领取失败' };
}
/** 从信封里取任务数组。 */
function tasksOf(result) {
    if (!result.ok || result.body.code !== 0) {
        return [];
    }
    const data = result.body.data;
    if (typeof data !== 'object' || data === null) {
        return [];
    }
    const tasks = data.tasks;
    return Array.isArray(tasks) ? tasks : [];
}
/**
 * 查询账号的成长任务列表，筛出「白名单且尚未接取/完成」的任务码。
 * 返回 `ok:false`（而非空 `codes`）表示查询失败 —— 让调用方区分「查不到」与「没有可接任务」。
 */
export async function fetchGrowthTaskCodes(credential, product, fetcher = fetch, options = {}) {
    const includeInProgress = options.includeInProgress === true;
    /**
     * ⚠ 必须**合并**两个端点，不能命中第一个就 return。
     *
     * 成长中心有两族任务，schema 完全不同：
     *
     * | 族 | 端点 | 码字段 | 状态字段 | progress |
     * |---|---|---|---|---|
     * | 成长任务 | `/v2/activity/growth/tasks` | `task_code` | `accept_status` | 有 |
     * | 养虾等级 | `/activity/growth/tasks` | `code` | `status`（`available` 等） | **无** |
     *
     * 原实现命中 `/v2/...` 就返回 ⇒ 等级族 5 项（`first_chat` / `skill_installed` /
     * `wechat_linked` / `expert_summoned` / `template_used`）**永远进不了待办**。
     * 且它只读 `task_code`，等级族返回的是 `code`，即使读到也会被跳过。
     */
    const progressByCode = {};
    const pending = [];
    const toAccept = new Set();
    let total = 0;
    let anyOk = false;
    /** 首个失败原因（供下游区分「凭据失效」与「没有任务」，见 GrowthTaskQuery.message）。 */
    let failureMessage = '';
    for (const path of GROWTH_TASKS_PATHS) {
        const result = await getGrowthJson(path, credential, product, fetcher);
        if (!result.ok || result.body.code !== 0) {
            // 只留首个原因：两个端点通常同因失败，后者多为级联。
            if (failureMessage.length === 0) {
                failureMessage = result.ok
                    ? `任务列表返回 code ${String(result.body.code)}`
                    : result.message;
            }
            continue;
        }
        anyOk = true;
        const tasks = tasksOf(result);
        total += tasks.length;
        for (const task of tasks) {
            if (typeof task !== 'object' || task === null) {
                continue;
            }
            // 两族的码字段不同：`task_code`（成长）/ `code`（等级）。
            const taskCode = readString(task, 'task_code') || readString(task, 'code');
            if (!AUTOMATABLE_TASK_CODES.has(taskCode)) {
                continue;
            }
            const progress = task.progress ?? {};
            const acceptStatus = readString(task, 'accept_status');
            if (acceptStatus !== '') {
                // 成长族：按 progress 与 accept_status 判定。
                progressByCode[taskCode] = {
                    current: readNumber(progress, 'current'),
                    target: readNumber(progress, 'target') || 1,
                };
                if (includeInProgress) {
                    if (acceptStatus === 'not_accepted' ||
                        acceptStatus === 'in_progress' ||
                        acceptStatus === 'accepted') {
                        pending.push(taskCode);
                        if (acceptStatus === 'not_accepted') {
                            toAccept.add(taskCode);
                        }
                    }
                }
                else if (acceptStatus === 'not_accepted') {
                    pending.push(taskCode);
                }
                continue;
            }
            // 等级族：无 accept_status、无 progress，判据是服务端记录的真实活动。
            // `status` 非 available 即视为已达成（不再重复做）。
            const status = readString(task, 'status');
            progressByCode[taskCode] = { current: status === 'available' ? 0 : 1, target: 1 };
            if (status === 'available') {
                pending.push(taskCode);
            }
        }
    }
    if (!anyOk) {
        return {
            ok: false, codes: [], total: 0,
            message: failureMessage.length > 0 ? failureMessage : '任务列表查询失败',
        };
    }
    const base = { ok: true, codes: [...new Set(pending)], total };
    return includeInProgress ? { ...base, toAccept, progressByCode } : base;
}
/**
 * 执行**每日成长领取**（低副作用核心）。
 *
 * 步骤（串行，防风控）：
 *   1. 拉任务列表，接取所有「白名单且 not_accepted」的任务；
 *   2. 旅行领奖 —— 无未领旅行时归类为 `already-claimed`。
 *
 * 返回单个 {@link ClaimOutcome}：`kind` 取**本次真正到账**的口径 ——
 * 只要接取或领奖**任一成功**且到账 credit/energy > 0 计 `claimed`（接取本身
 * 不加积分，credit 取旅行领奖的 `reward_credit`；接取成功但无旅行奖时 credit=0
 * 仍计 `claimed`，因为已把可完成任务推进到 in_progress）。全部无对象计
 * `already-claimed`；网络/解析失败计 `failed`。
 *
 * ⚠️ `runExotic`（默认 `false`）开启时才追加盲盒/抽奖/首Buddy 的**有代价/一次性**
 * 动作。默认路径只做接取+旅行领奖，避免误触消耗 energy / 一次性解锁。
 */
export async function claimAllGrowth(credential, product, fetcher = fetch, options = {}) {
    const runExotic = options.runExotic === true;
    const notes = [];
    let acceptedCount = 0;
    let acceptedOk = false;
    // 1) 任务接取
    const tasks = await fetchGrowthTaskCodes(credential, product, fetcher);
    if (tasks.ok && tasks.codes.length > 0) {
        const acceptResult = await postGrowthJson(GROWTH_TASK_ACCEPT_PATH, credential, product, { task_codes: tasks.codes }, fetcher);
        const accept = classifyGrowthWrite(acceptResult);
        if (accept.state === 'success') {
            acceptedOk = true;
            acceptedCount = tasks.codes.length;
        }
        else if (accept.state === 'failed') {
            // 接取失败不阻断旅行领奖（两段独立），但如实上报。
            notes.push(`任务接取失败：${accept.message}`);
        }
    }
    // 2) 旅行领奖
    const travel = classifyGrowthWrite(await postGrowthJson(GROWTH_TRAVEL_CLAIM_PATH, credential, product, {}, fetcher));
    let credit = 0;
    if (travel.state === 'success') {
        credit = readNumber(travel.data, 'reward_credit');
        if (credit > 0 || acceptedOk) {
            notes.push(credit > 0 ? `旅行领奖 +${credit}` : '已接取待完成任务');
        }
        else {
            notes.push('旅行已领奖');
        }
    }
    else if (travel.state === 'no-object') {
        // 「无未领旅行」是正常终态：若上面也没接取成功，则整轮无新增。
        if (notes.length === 0) {
            notes.push(travel.message);
        }
    }
    else {
        notes.push(`旅行领奖失败：${travel.message}`);
    }
    // 3)（可选）有代价动作 —— 默认关闭
    let exoticCredit = 0;
    if (runExotic) {
        const first = classifyGrowthWrite(await postGrowthJson(GROWTH_FIRST_BUDDY_PATH, credential, product, {}, fetcher));
        if (first.state === 'success') {
            exoticCredit += readNumber(first.data, 'reward_credit');
            notes.push('已解锁首个 Buddy');
        }
        const box = classifyGrowthWrite(await postGrowthJson(GROWTH_BLIND_BOX_PATH, credential, product, { count: 1 }, fetcher));
        if (box.state === 'success') {
            notes.push('已开启盲盒');
        }
        const lottery = classifyGrowthWrite(await postGrowthJson(GROWTH_LOTTERY_PATH, credential, product, { client_token: `jh-${Date.now()}` }, fetcher));
        if (lottery.state === 'success') {
            notes.push('已抽奖');
        }
    }
    // 汇总为单个 ClaimOutcome（与 credits.ts 的汇总口径对齐）
    const totalCredit = credit + exoticCredit;
    const anyProgress = acceptedOk || totalCredit > 0;
    if (anyProgress) {
        const claimed = {
            kind: 'claimed',
            credit: totalCredit,
            streakDays: 0,
            isStreakDay: false,
            ...(notes.length > 0 ? { message: notes.join('；') } : {}),
            ...(acceptedCount > 0 ? { acceptedCount } : {}),
        };
        return claimed;
    }
    if (travel.state === 'no-object' ||
        notes.some((n) => /暂无可领取|无未领|已领奖/.test(n))) {
        return {
            kind: 'already-claimed',
            message: notes.length > 0 ? notes.join('；') : '暂无可领取的成长奖励',
        };
    }
    if (notes.length > 0 && notes.every((n) => /失败/.test(n))) {
        return { kind: 'failed', code: -1, message: notes.join('；') };
    }
    return { kind: 'failed', code: -1, message: '成长中心无可用奖励' };
}
/** 保连胜：向 buddy-adapter 同款 chat completions 端点发一条「你好」，
 * 触发一次「活跃」记录以维持 `streak_days`（签到积分倍数基数）。
 *
 * 不新建通道 —— 复用 buddy 既有 `POST ${product.endpoint}/v2/chat/completions`
 * 端点与 `product.userAgent`（归因账单用），只改 body。连胜断一天签到基数归零，
 * 故这是本机唯一还能 API 化的积分相关动作（做任务本身必须客户端真操作）。
 * 幂等：重复调用只是多发一次对话，不重复计积分（活跃按天去重，服务端保证）。
 * 低频：串行 + 单账号单条，避免触发风控。
 */
export async function keepStreakActive(credential, product, fetcher = fetch) {
    const body = {
        model: 'default-model',
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 8,
        stream: true,
    };
    try {
        const response = await fetcher(`${product.endpoint}/v2/chat/completions`, {
            method: 'POST',
            headers: growthHeaders(credential, product),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 401 || response.status === 403) {
            return { ok: false, message: `凭据已失效（HTTP ${response.status}），请重新登录该账号` };
        }
        if (!response.ok || !response.body) {
            const text = await response.text().catch(() => '');
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = null;
            }
            const reason = parsed === null ? '' : readString(parsed, 'msg') || readString(parsed, 'error');
            const message = reason.length > 0 ? reason : `保连胜请求失败（HTTP ${response.status}）`;
            return { ok: false, message };
        }
        // 读 SSE 流直到拿到首个内容块（活跃已记录）或流结束；不消费完整个回复，省 token。
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                // 首个 data 行即表明服务端已受理本次对话，足够记录一次活跃。
                if (/^data:/.test(buffer) || buffer.includes('"delta"') || buffer.includes('"content"')) {
                    break;
                }
            }
        }
        catch (error) {
            return {
                ok: false,
                message: `保连胜流读取失败：${error instanceof Error ? error.message : String(error)}`,
            };
        }
        return { ok: true, message: '已发送保活跃消息' };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            return { ok: false, message: '保连胜请求超时' };
        }
        return {
            ok: false,
            message: `保连胜请求失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/** 查询当前连胜天数与今日是否已活跃。端点基址随 `product.endpoint`。 */
export async function fetchStreakStatus(credential, product, fetcher = fetch) {
    const result = await getGrowthJson(GROWTH_TASKS_PATHS[0].replace('/tasks', '/streak'), credential, product, fetcher);
    if (!result.ok || result.body.code !== 0) {
        return { ok: false, days: 0, activeToday: false };
    }
    const data = result.body.data;
    if (typeof data !== 'object' || data === null) {
        return { ok: true, days: 0, activeToday: false };
    }
    return {
        ok: true,
        days: readNumber(data, 'days'),
        activeToday: data.active_today === true,
    };
}
/**
 * 建一次画布会话（`create_canvas` 的前置动作，副作用最小档）。
 *
 * ⚠️ **只带极简头**（Authorization + Content-Type + User-Agent，与 curl 实证
 * 200 的那套一致）。`/console/as/` 会话族端点对 `growthHeaders` 的多余身份头
 * （`X-Client-Platform:web` / `X-Domain` / `X-Product` / `X-Product-Code`）做
 * 鉴权收紧会回 401，故不能复用 `growthHeaders`——这与成长中心族端点要全套头
 * 的特性相反。
 */
export async function createCanvasTask(credential, product, fetcher = fetch) {
    try {
        const response = await fetcher(`${baseOf(product)}/console/as/conversations/`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: minimalHeaders(credential, product),
            body: JSON.stringify({ title: 'canvas' }),
        });
        const text = await response.text();
        let payload;
        try {
            payload = JSON.parse(text);
        }
        catch {
            return { ok: false, message: describeNonJsonResponse(response.status, text) };
        }
        if (typeof payload !== 'object' || payload === null) {
            return { ok: false, message: '建画布会话响应无法解析' };
        }
        if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
            return {
                ok: false,
                message: payload.msg ?? `建画布会话接口 HTTP ${response.status}`,
            };
        }
        const data = typeof payload.data === 'object' && payload.data !== null
            ? payload.data
            : {};
        const conversationId = readString(data, 'id');
        return {
            ok: true,
            conversationId,
            message: conversationId.length > 0 ? `画布会话已建（${conversationId}）` : '画布会话已建',
        };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            return { ok: false, message: '建画布会话请求超时' };
        }
        return {
            ok: false,
            message: `建画布会话失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * 各「API 可达」成长任务的**完成动作**映射。
 *
 * 与 {@link AUTOMATABLE_TASK_CODES}（可接取）区分：接取把任务置 `in_progress`，
 * **积分在完成动作后由服务端发放**。本表只列能纯 API 完成的 task_code；
 * 微信服务号订阅（wb_wechat_oa_subscribe_task）等仅客户端可完成的不在这里（CLIENT_ONLY 降级）。
 *
 * 动作类型（按副作用递增）：
 * - `canvas`：建一条画布会话（`create_canvas`）。
 * - `chat`：发对话/事件链（`playbook_prompt`/`chat_5`/`expert_5`/`template_5`…）。
 * - `canvasThenChat`：先建画布再发首条消息（`create_canvas` 的完整闭环）。
 * - `webClick`：web 域浏览器指纹单事件（`Library_read` 判据）。
 * - `appearance`：主题设置 API + 皮肤生效事件（`Hp_Appearance` 判据）。
 * - `skillFresh`：真实会话（服务端 id）+ skill_info 事件（`skill_1` 判据）。
 *
 * 每项的完成动作**可重复**（服务端按天去重/幂等），重复触发不重复计积分；
 * 风控纪律靠**串行单账号单动作 + 白名单限定**兜住。
 */
export const GROWTH_TASK_COMPLETION = {
    create_canvas: { kind: 'canvasThenChat', label: '建画布并发一条消息' },
    playbook_prompt: { kind: 'chat', label: '做同款对话' },
    chat_5: { kind: 'chat', label: '发一条对话' },
    Buddy_App: { kind: 'chat', label: 'Buddy App 会话' },
    Buddy_App_QQ: { kind: 'chat', label: 'Buddy App QQ 会话' },
    expert_5: { kind: 'chat', label: '专家对话' },
    Expert_team_use_3: { kind: 'chat', label: '专家团队对话' },
    Expert_lighthouse: { kind: 'chat', label: '轻量云专家对话' },
    automation_1: { kind: 'chat', label: '自动化触发' },
    black_cat: { kind: 'chat', label: '夜猫子 glm-5.2 对话' },
    'Model_chat_GLM5.2': { kind: 'chat', label: '指定模型对话' },
    template_5: { kind: 'chat', label: '使用 5 个模板创建任务' },
    RichMeow_Chat: { kind: 'chat', label: '桌面端对话（fast-model）' },
    Library_read: { kind: 'webClick', label: '资料库介绍点击（web 域）' },
    Hp_Appearance: { kind: 'appearance', label: '换主题 + 皮肤生效事件' },
    skill_1: { kind: 'skillFresh', label: '真实对话 + skill_info 技能加载' },
    wb_wechat_oa_subscribe_task: { kind: 'chat', label: '微信服务号订阅（需客户端）' },
    // ── 「养虾等级」任务族（第二族，来自 `/activity/growth/tasks`）──
    first_chat: { kind: 'chat', label: '完成一次对话（等级任务）' },
    template_used: { kind: 'chat', label: '使用一次模板（等级任务）' },
    expert_summoned: { kind: 'chat', label: '召唤一次专家（等级任务）' },
    skill_installed: {
        kind: 'skillFresh',
        label: '完成技能安装（等级任务，判据 skill_info）',
    },
    wechat_linked: { kind: 'chat', label: '链接微信（等级任务，需客户端）' },
};
/** 桌面事件上报的字段顺序（照 WorkBuddy 桌面端 `DesktopChatSequence`）。 */
const DESKTOP_EVENT_ORDER = [
    'agent_task_created',
    'chat_message_send',
    'chat_request_send',
    'chat_message_response',
    'chat_message_status',
    'chat_request_response',
];
/** 桌面指纹（模拟固定 WorkBuddy 桌面端）。 */
function desktopFingerprint(credential, product) {
    const uid = String(credential.user_id || '');
    const nickname = String(credential.nickname || '');
    const hash = (salt) => {
        try {
            return Buffer.from(sha256Hex(`${salt}:${uid}`)).toString('hex').slice(0, 36);
        }
        catch {
            return `${salt}-${uid.slice(0, 12)}`;
        }
    };
    return {
        timezone: 'Asia/Shanghai',
        reportDelay: 2000,
        userId: uid,
        username: nickname,
        userNickname: nickname,
        product: BUDDY_DEPLOYMENT_TYPE,
        releaseDate: 1789036585355,
        commit: '5f9692923c93033111c51ad7b003eb80204a9b75',
        ideName: 'WorkBuddy',
        ideType: 'WorkBuddy',
        ideVersion: '5.5.6',
        machineId: hash('machine'),
        sessionId: hash('session'),
        extName: 'workbuddy-desktop',
        extVersion: '5.5.6',
        ...platformIdentity(),
        cpuCores: 8,
        memorySize: 16,
        timestamp: Date.now(),
        presentAt: Date.now(),
        ideVersionCli: product.cliVersion || '2.137.1',
    };
}
/** 构造一组事件体的通用小工具。 */
function events(code, count, extra) {
    return Array.from({ length: count }, () => ({ eventCode: code, ...extra }));
}
/**
 * 通用对话六连事件链（`agent_task_created → … → chat_request_response`）。
 *
 * @param model `requestModelId` / `responseModelId` 的取值。
 * @param modelName `requestModelName` 的取值。**必须与 model 分开传** ——
 *   服务端按模型**名**对齐「体验某模型」类任务：`Model_chat_GLM5.2` 的判据是
 *   `requestModelId=glm-5.2` 且 `requestModelName=GLM-5.2`（大小写不同）。
 *   两者同值时该任务不计数。缺省等于 `model`，其余任务沿用同值即可。
 */
function chatEventChain(model, conversationId, requestId, modelName = model) {
    const messageId = `${conversationId}-m`;
    const uuid = requestId;
    const common = {
        traceId: uuid,
        rootRequestId: requestId,
        parentConversationId: conversationId,
        agentName: 'cli',
        agentType: 'main',
        'codebuddy.session_id': conversationId,
        'codebuddy.conversation_request_id': requestId,
    };
    return [
        {
            eventCode: DESKTOP_EVENT_ORDER[0],
            source: 'LOCAL', name: 'working', task_target: 'local', mode: 'craft',
            requestModelId: model, requestModelName: modelName, has_repo: false, repo_type: 'none',
            workspace_type: 'empty', has_connector: false, connector_types: [], has_mention: false,
            mention_types: [], has_template: false, action: '', template_name: '', has_expert: false,
            expert_id: '', expert_name: '', expert_industry_id: '', has_skill: false, skill_names: [],
            conversationId, messageId, buddyId: '', buddyName: '',
        },
        {
            eventCode: DESKTOP_EVENT_ORDER[1],
            messageId: `${messageId}-assistant`, historyCount: 0, isContextTruncated: false,
            currentStepCount: 1, ...common,
        },
        {
            eventCode: DESKTOP_EVENT_ORDER[2],
            inputLength: 24, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
            codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
            mentionContexts: [], knowledgeId: [], knowledgeName: [], codebaseId: '',
            mentionContextCount: 0, command: '', recommendId: '', skillId: '', skillCount: 0,
            totalCount: 0, ...common,
        },
        {
            eventCode: DESKTOP_EVENT_ORDER[3],
            messageId: `${messageId}-assistant`, responseModelId: model, inputToken: 120,
            outputToken: 80, totalToken: 200, cachedTokens: 0, cachedWriteTokens: 0,
            cachedMissTokens: 0, isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
            firstTokenAt: Date.now(), conversationId, ...common,
        },
        {
            eventCode: DESKTOP_EVENT_ORDER[4],
            messageId: `${messageId}-assistant`, messageErrorCode: '0', ...common,
        },
        {
            eventCode: DESKTOP_EVENT_ORDER[5],
            mode: 'craft', toolCallCount: 0, inputToken: 120, outputToken: 80, totalToken: 200,
            cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0, isSuccessful: true,
            messageErrorCode: '', finishReason: 'stop', ...common,
        },
    ];
}
/**
 * 构造**单条** `chat_request_send` 事件。
 *
 * ## 为什么单独造这个构造器（而不用 chatEventChain 的六连）
 *
 * 「体验某模型」类任务（`Model_chat_GLM5.2`）的判据是**一条**带正确模型字段的
 * `chat_request_send`：Go 侧 `ReportChatActivityModel` 只发这一条，多余事件不参与
 * 判定。附带两个必须照抄的细节：
 *
 * 1. `requestModelId` 与 `requestModelName` **不同值**（`glm-5.2` / `GLM-5.2`）。
 * 2. `requestID` 传空串 → 回落成 `conversationID`。也就是说**不需要真实会话的
 *    requestId**，只要自生成的会话 id 与一条真实对话并存即可。
 *
 * @param modelId `requestModelId`，如 `glm-5.2`
 * @param modelName `requestModelName`，如 `GLM-5.2`
 * @param conversationId 自生成的会话 id（服务端不校验其真实性）
 */
function chatRequestSendEvent(modelId, modelName, conversationId) {
    const requestId = conversationId;
    return {
        eventCode: DESKTOP_EVENT_ORDER[2],
        mode: 'craft',
        conversationId,
        requestId,
        inputLength: 12,
        requestModelId: modelId,
        requestModelName: modelName,
        isPlan: false,
        isAutoExecuteTerminal: false,
        isAutoModify: false,
        codebaseEnable: false,
        maxToken: 0,
        maxSteps: 0,
        temperature: 0,
        maxRetries: 0,
        mentionContexts: [],
        knowledgeId: [],
        knowledgeName: [],
        codebaseId: '',
        mentionContextCount: 0,
        command: '',
        expertId: '',
        recommendId: '',
        skillId: '',
        skillCount: 0,
        totalCount: 0,
        fileUri: '',
        presentAt: Date.now(),
        traceId: requestId,
        rootRequestId: requestId,
        parentConversationId: conversationId,
        agentName: 'cli',
        agentType: 'main',
    };
}
/** Buddy 应用「进入应用」五连事件（实测点亮 Buddy_App / Buddy_App_QQ）。 */
function buddyAppEventChain(buddyId, buddyName) {
    const common = { mode: 'LOCAL', buddyId, buddyName, elementId: buddyId, elementName: buddyName };
    return [
        { eventCode: 'buddyapp_discover_click', ...common },
        { eventCode: 'buddyapp_show', ...common, position: 2 },
        { eventCode: 'buddyapp_enter_click', ...common, position: 2, isFirstPage: '1' },
        { eventCode: 'buddyapp_auth_confirm_click', ...common },
        { eventCode: 'buddyapp_bindaccount_skip_click', ...common },
    ];
}
/** 模板任务「使用模板创建」事件组（实测点亮 template_5）：对话链 + template 事件。 */
function templateUseEventChain(templateId, templateName, conversationId, requestId) {
    return [
        ...chatEventChain(FAST_MODEL, conversationId, requestId),
        {
            eventCode: 'agent_task_created_with_template', mode: 'working', isCustomModel: false,
            id: templateId, name: templateName, requestId,
        },
        { eventCode: 'template_used', template_id: templateId, task_mode: 'working' },
    ];
}
/** 灵感案例「做同款」事件组（实测点亮 playbook_prompt）：对话链 + playbook 点击/发送。 */
function playbookPromptEventChain(caseId, caseName, conversationId, requestId) {
    const payload = { id: caseId, name: caseName, type: 'document', categoryId: '', categoryName: '' };
    return [
        ...chatEventChain(FAST_MODEL, conversationId, requestId),
        {
            eventCode: 'web_element_click', pageName: 'playbook_detail',
            elementId: 'playbook_ctaClick', elementName: caseName, source: 'discover',
        },
        { eventCode: 'playbook_cta_click', source: 'discover', position: 0, ...payload },
        { eventCode: 'playbook_prompt_send', conversationId, requestId, ...payload },
    ];
}
/** 定时任务创建成功事件。 */
function automationCreateEvent(name) {
    return events('automated_task_create_suc', 1, {
        name, source: 'manually', modelId: FAST_MODEL,
        modelIsThinking: true, connectorCount: 0, skills: '', skillCount: 0, scheduleType: 'once',
        mode: 'LOCAL',
    });
}
/**
 * 专家召唤事件链（`expert_summon_click → expert_summoned → expert_actual_use`）。
 * `expert` = `fetchMarketExpertList` 取到的真实专家。
 *
 * `requestId` 由调用方填真实会话 id（服务端对 `expert_actual_use` 的 requestId
 * 有校验倾向；纯 API 口径下用生成值，若不计数则降级 clientOnly，不谎报完成）。
 */
function expertEventChain(expert, conversationId, requestId, product) {
    const cat = 'expert-all';
    const version = expert.version ?? '1.0.0';
    return [
        {
            eventCode: 'web_element_click',
            source: expert.expertId, type: cat, version, elementId: 'expert_summon_click',
            elementName: '立即召唤', pageURL: `${baseOf(product)}/`,
        },
        {
            eventCode: 'expert_summon_click',
            id: expert.expertId, name: expert.name, expertTitle: expert.title,
            type: cat, position: 0, expertType: expert.expertType, version, mode: 'LOCAL',
        },
        {
            eventCode: 'expert_summoned',
            id: expert.expertId, name: expert.name, expertTitle: expert.title, type: cat,
        },
        {
            eventCode: 'expert_actual_use',
            id: expert.expertId, name: expert.name, expertType: expert.expertType,
            conversationId, requestId, inputToken: 120,
            outputToken: 80, totalToken: 200, isSuccessful: true,
        },
    ];
}
/**
 * 按任务代码选择「完成动作事件序列」：
 * - `Buddy_App`/`Buddy_App_QQ` → Buddy 应用五连（判据只认 buddyId，两族同源）。
 * - `automation_1` → 定时任务创建成功。
 * - 其余聊天类（`chat_5`/`expert_5`/`template_5`/`Model_chat_GLM5.2`/`playbook_prompt`…）
 *   → 通用对话链（`Model_chat_GLM5.2` 带 `glm-5.2` 模型，其余通用款）。
 * 资料库/皮肤/QQ 外观等纯 UI 动作不在此（仍 clientOnly）。
 */
function buildTaskEventSequence(taskCode, model, round, extraOptions, product) {
    const conversationId = extraOptions.conversationId ?? `jb-${Date.now()}-${round}`;
    const requestId = extraOptions.requestId ?? `${conversationId}-r${round}`;
    const expert = extraOptions.expert;
    if (taskCode === 'Hp_Appearance') {
        // 判据 = appearance_skin_apply（客户端主题生效离开设置页时上报）；纯 set API 不计分。
        return {
            events: events('appearance_skin_apply', 1, {
                action: 'apply', source: 'settings_close',
                id: APPEARANCE_THEME_KEY, vipLevel: 0, series: '', type: 'unknown',
            }),
            conversationId,
            requestId,
        };
    }
    if (taskCode === 'skill_1') {
        const messageId = `${conversationId}-m`;
        const chain = chatEventChain(FAST_MODEL, conversationId, requestId);
        const response = chain.find((e) => e.eventCode === DESKTOP_EVENT_ORDER[3]);
        if (response) {
            response.finishReason = 'tool_calls';
        }
        chain.push({
            eventCode: 'skill_info', id: '润泽小馆·日报撰写',
            skillId: SKILL_ID, skillVersion: '1.0.0',
            toolStatus: 'success', fileCount: 56, source: 'workbuddy-desktop',
            conversationId, requestId, messageId,
            requestModelId: FAST_MODEL, requestModelName: FAST_MODEL, traceId: requestId,
        });
        return { events: chain, conversationId, requestId, model: FAST_MODEL };
    }
    if (taskCode === 'create_canvas') {
        // 判据是设计创意画布遥测（Ardot create_design 完成时上报），不是画布会话本身。
        const chain = chatEventChain(FAST_MODEL, conversationId, requestId);
        chain.push({
            eventCode: 'wbx_design_canvas_task_create', conversationId, requestId,
            source: 'summon_keyword', cost: 12000, isSuccessful: true,
        }, {
            eventCode: 'wbx_design_canvas_open', conversationId, requestId,
            id: `ardot-file-${requestId.slice(-8)}`, source: 'summon_keyword',
            type: 'page', cost: 13000, isSuccessful: true,
        });
        return { events: chain, conversationId, requestId, model: FAST_MODEL };
    }
    if (taskCode === 'Buddy_App' || taskCode === 'Buddy_App_QQ') {
        // 应用类判据只认 buddyId，不区分应用名。Buddy_App（进入任一应用）与
        // Buddy_App_QQ 判据同源，故共用同一个 id。
        return {
            events: buddyAppEventChain(BUDDY_APP_ID, taskCode === 'Buddy_App_QQ' ? '企鹅教师助手' : 'Buddy'),
            conversationId,
            requestId,
        };
    }
    if (taskCode === 'automation_1') {
        return { events: automationCreateEvent('jb-automation'), conversationId, requestId };
    }
    if (taskCode === 'template_5') {
        const templates = [
            ['1', '深度研究'], ['2', '周报生成'], ['3', '竞品分析'], ['4', '活动策划'], ['5', '代码评审'],
        ];
        const tpl = templates[round % templates.length];
        return {
            events: templateUseEventChain(tpl[0], tpl[1], conversationId, requestId),
            conversationId,
            requestId,
        };
    }
    if (taskCode === 'playbook_prompt') {
        return {
            events: playbookPromptEventChain(`case-jb-${round}`, 'jb灵感案例', conversationId, requestId),
            conversationId,
            requestId,
        };
    }
    // 专家/专家团类：expert_actual_use 需平台真实 expert_id（编造不计数），由调用方
    // 先拉 MarketExpertList 取真 id 注入（`expert` 字段）；未注入时回退通用对话链。
    if (taskCode === 'expert_5' || taskCode === 'Expert_team_use_3') {
        if (expert?.expertId) {
            return {
                events: expertEventChain(expert, conversationId, requestId, product),
                conversationId,
                requestId,
                model: model ?? FAST_MODEL,
            };
        }
        return {
            events: chatEventChain(model ?? FAST_MODEL, conversationId, requestId),
            conversationId,
            requestId,
            model: model ?? FAST_MODEL,
        };
    }
    // 轻量云专家（Expert_lighthouse）：专家召唤链 + mode=LOCAL 的 expert_actual_use 变体。
    // 专家 id 由调用方注入（专家市场 agent 型）；未注入时回退通用对话链。
    if (taskCode === 'Expert_lighthouse') {
        if (expert?.expertId) {
            // 真实轻量云样本顺序：3 条召唤 → fast-model 对话六连（agent_task_created 带
            // has_expert）→ 单条 LOCAL expert_actual_use（type 空、cost 0）。
            const summon = expertEventChain(expert, conversationId, requestId, product).slice(0, 3);
            const chat = chatEventChain(model ?? FAST_MODEL, conversationId, requestId).map((e) => e.eventCode === DESKTOP_EVENT_ORDER[0]
                ? {
                    ...e,
                    has_expert: true,
                    expert_id: expert.expertId,
                    expert_name: expert.name,
                    expert_industry_id: expert.industryId ?? '',
                }
                : e);
            return {
                events: [
                    ...summon,
                    ...chat,
                    {
                        eventCode: 'expert_actual_use', id: expert.expertId, name: expert.name,
                        expertType: expert.expertType, conversationId, requestId,
                        inputToken: 120, outputToken: 80, totalToken: 200,
                        isSuccessful: true, mode: 'LOCAL', type: '', cost: 0,
                    },
                ],
                conversationId,
                requestId,
                model: model ?? FAST_MODEL,
            };
        }
        return {
            events: chatEventChain(model ?? FAST_MODEL, conversationId, requestId),
            conversationId,
            requestId,
            model: model ?? FAST_MODEL,
        };
    }
    // 夜猫子（black_cat）：glm-5.2 对话链推进（判据是 glm-5.2 夜间对话计数）。
    if (taskCode === 'black_cat') {
        return {
            events: chatEventChain(GLM_MODEL_ID, conversationId, requestId),
            conversationId,
            requestId,
            model: GLM_MODEL_ID,
        };
    }
    if (taskCode === 'RichMeow_Chat') {
        return {
            events: chatEventChain(FAST_MODEL, conversationId, requestId),
            conversationId,
            requestId,
            model: FAST_MODEL,
        };
    }
    /**
     * ── 「养虾等级」任务族（第二族：来自 `/activity/growth/tasks`，与成长任务不同端点）──
     *
     * ⚠ 这族没有 `progress` / `accept_status`，判据是服务端记录的真实活动，
     * 故一律走「已实测点亮」的既有链路，不另造机制。
     */
    if (taskCode === 'first_chat') {
        // 「完成一次对话」：判据就是存在一次真实对话，与 skill_1 同款（已实测 1/1）。
        return {
            events: chatEventChain(FAST_MODEL, conversationId, requestId),
            conversationId,
            requestId,
            model: FAST_MODEL,
        };
    }
    if (taskCode === 'template_used') {
        // 「使用一次模板」：对话链 + agent_task_created_with_template + template_used
        // （template_5 已 5/5）。
        const tplId = extraOptions.templateId ?? '1';
        const tplName = extraOptions.templateName ?? '深度研究';
        const tplConv = `jb-tpl-${conversationId.replace(/\D/g, '') || Date.now()}`;
        return {
            events: [
                ...templateUseEventChain(tplId, tplName, tplConv, requestId),
                { eventCode: 'template_used', template_id: tplId, task_mode: 'working' },
            ],
            conversationId: tplConv,
            requestId,
            model: FAST_MODEL,
        };
    }
    if (taskCode === 'expert_summoned') {
        // 「召唤一次专家」：expert_5 已 5/5，机制完全一致。
        // ⚠ `expert_id` 必须是市场真实 id（编造不计数），故由调用方经 `expert` 注入；
        // 未注入时回退通用对话链，由调用方判失败。
        if (expert?.expertId) {
            return {
                events: expertEventChain(expert, conversationId, requestId, product),
                conversationId,
                requestId,
                model: FAST_MODEL,
            };
        }
        return {
            events: chatEventChain(FAST_MODEL, conversationId, requestId),
            conversationId,
            requestId,
            model: FAST_MODEL,
        };
    }
    if (taskCode === 'skill_installed') {
        // 「完成技能安装」：真判据是 `skill_info` 事件。
        // ⚠ 权威记载的教训 ——「此前的 `skill_request_send` / `skill_installed` /
        // `skill_action` 全是错误方向」，只有 `skill_info` 被实测点亮。
        // 故复用 skill_1 的同款事件组。
        return {
            events: buildTaskEventSequence('skill_1', FAST_MODEL, round, extraOptions, product).events,
            conversationId,
            requestId,
            model: FAST_MODEL,
        };
    }
    if (taskCode === 'Model_chat_GLM5.2') {
        /**
         * 「体验某模型」判据：一条带 glm-5.2 模型字段的 `chat_request_send`。
         *
         * ⚠ 两个必须照抄的细节，否则**不计数**（本任务曾因此长期 0/1）：
         *   - `requestModelId=glm-5.2` 与 `requestModelName=GLM-5.2` **大小写不同**
         *   - `requestId` 留空 → 回落成 `conversationId`，**不需要真实会话 id**
         */
        const glmConv = `jb-glm52-${Date.now()}-${round}`;
        return {
            events: [chatRequestSendEvent(GLM_MODEL_ID, GLM_MODEL_NAME, glmConv)],
            conversationId: glmConv,
            requestId: glmConv,
            model: GLM_MODEL_ID,
        };
    }
    // 聊天/模型类：其余走通用对话链。
    const chatModel = model ?? DEFAULT_CHAT_MODEL;
    return {
        events: chatEventChain(chatModel, conversationId, requestId),
        conversationId,
        requestId,
        model: chatModel,
    };
}
/**
 * 把一组事件注入桌面指纹 + 会话上下文 + 时间戳，一次 POST 到桌面域 `/v2/report`。
 */
async function reportDesktopEvents(credential, product, fetcher, eventList, conversationId, requestId) {
    const fingerprint = desktopFingerprint(credential, product);
    const body = eventList.map((ev) => ({
        ...fingerprint,
        ...ev,
        conversationId,
        requestId,
        timestamp: Date.now(),
        presentAt: Date.now(),
    }));
    try {
        const response = await fetcher(`${baseOf(product)}/v2/report`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                ...minimalHeaders(credential, product),
                'x-client-platform': 'web',
                ...(fingerprint['userId'] ? { 'X-User-Id': String(fingerprint['userId']) } : {}),
            },
            body: JSON.stringify(body),
        });
        if (response.status === 401 || response.status === 403) {
            return { ok: false, reported: 0, message: `凭据已失效（HTTP ${response.status}）` };
        }
        if (!response.ok) {
            return { ok: false, reported: 0, message: `事件上报请求失败（HTTP ${response.status}）` };
        }
        return { ok: true, reported: body.length, message: `已上报 ${body.length} 条事件` };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            return { ok: false, reported: 0, message: '事件上报请求超时' };
        }
        return {
            ok: false,
            reported: 0,
            message: `事件上报失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * 按任务代码上报「完成动作事件」，推进 progress。
 * `count` = 还需补的进度（target - current）；不同 round 用不同 conversationId 各计一次。
 * 串行 + 1s 节流。
 */
async function reportTaskEvents(credential, product, fetcher, taskCode, count, extraOptions) {
    let reported = 0;
    for (let round = 0; round < count; round++) {
        const seq = buildTaskEventSequence(taskCode, extraOptions.model, round, extraOptions, product);
        const result = await reportDesktopEvents(credential, product, fetcher, seq.events, seq.conversationId, seq.requestId);
        if (!result.ok) {
            return { ok: false, reported, message: result.message };
        }
        reported += result.reported;
        if (round < count - 1) {
            await new Promise((resolve) => setTimeout(resolve, ROUND_INTERVAL_MS));
        }
    }
    return { ok: true, reported, message: `已上报 ${reported} 条事件` };
}
/** 拉取专家市场真实专家列表（`POST /portal/operation-platform/market/expert/list`）。
 * `expert_5` / `Expert_team_use_3` 的完成判据要求 `expert_id` 是平台**真实**专家
 * （编造 id 不计数），故完成动作前必须先取真 id。
 * `expertType`：`agent`=单专家（expert_5），`team`=专家团（Expert_team_use_3）。
 */
export async function fetchMarketExpertList(credential, product, fetcher = fetch, expertType = 'agent') {
    const query = {
        page: 1,
        page_size: 20,
        sort_by: 'reco_rank',
        sort_order: 'desc',
        expert_type: expertType,
    };
    try {
        const response = await fetcher(`${baseOf(product)}/portal/operation-platform/market/expert/list`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { ...minimalHeaders(credential, product), 'x-client-platform': 'web' },
            body: JSON.stringify(query),
        });
        if (response.status === 401 || response.status === 403) {
            return { ok: false, experts: [], message: `凭据已失效（HTTP ${response.status}）` };
        }
        if (!response.ok) {
            return { ok: false, experts: [], message: `专家市场查询失败（HTTP ${response.status}）` };
        }
        let payload;
        try {
            payload = JSON.parse(await response.text());
        }
        catch {
            return { ok: false, experts: [], message: '专家市场返回无法解析的数据' };
        }
        if (typeof payload !== 'object' || payload === null) {
            return { ok: false, experts: [], message: '专家市场返回无法解析的数据' };
        }
        const envelope = payload;
        if (envelope.code !== undefined && envelope.code !== 0) {
            return {
                ok: false,
                experts: [],
                message: `专家市场查询失败：${readString(envelope, 'msg')}`,
            };
        }
        const data = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : envelope);
        const list = data['experts'] ?? data['list'];
        const rows = Array.isArray(list) ? list : [];
        const experts = rows
            .filter((row) => {
            if (typeof row !== 'object' || row === null) {
                return false;
            }
            const record = row;
            return Boolean(record['expert_id'] ?? record['id']);
        })
            .map((row) => {
            const record = row;
            return {
                expertId: String(record['expert_id'] ?? record['id']),
                expertType: String(record['expert_type'] ?? expertType),
                name: String(record['display_name_zh'] ?? record['display_name'] ?? record['name'] ?? ''),
                title: String(record['profession_zh'] ?? ''),
            };
        });
        return {
            ok: experts.length > 0,
            experts,
            message: experts.length > 0 ? `取到 ${experts.length} 个专家` : '专家市场无可用专家',
        };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            return { ok: false, experts: [], message: '专家市场查询超时' };
        }
        return {
            ok: false,
            experts: [],
            message: `专家市场查询失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * 读**全量**成长任务 code（含 not_accepted / in_progress / accepted / completed），
 * 供扫尾补领覆盖所有「已完成未领取」的任务（而非只 not_accepted 子集）。
 * 全失败返回空数组。
 *
 * ⚠️ 与 {@link fetchGrowthTaskCodes} 同款的两个要求，**改这里时必须一起改**，
 * 否则扫尾会静默漏项（两处一旦分叉，只有这里漏，且不报错）：
 *
 * 1. **必须合并两个端点**，不能命中第一个就返回。`/v2/activity/growth/tasks`
 *    （成长族）非空时若直接返回，第二端点（等级族）的任务永远进不了扫尾。
 *    这与 `fetchGrowthTaskCodes` 的注释是同一个坑，此处曾复发。
 * 2. **码字段名两族不同**：成长族是 `task_code`，等级族是 `code`。
 *    只读 `task_code` 会让等级族全部被 `.filter(code.length > 0)` 静默丢掉。
 */
async function listAllGrowthTaskCodes(credential, product, fetcher) {
    const codes = new Set();
    for (const path of GROWTH_TASKS_PATHS) {
        const result = await getGrowthJson(path, credential, product, fetcher);
        if (!result.ok || result.body.code !== 0) {
            continue;
        }
        for (const task of tasksOf(result)) {
            // 两族的码字段不同：`task_code`（成长）/ `code`（等级）—— 同 fetchGrowthTaskCodes。
            const code = readString(task, 'task_code') || readString(task, 'code');
            if (code.length > 0) {
                codes.add(code);
            }
        }
    }
    return [...codes];
}
/**
 * 领取单个成长任务奖励。
 *
 * 端点实测口径（对齐网页「领取」按钮真实请求）：
 * **`POST {claimBase}/activity/growth/tasks/<task_code>/claim`** ——
 * `task_code` 放 URL 路径、**不带 `/v2` 前缀**、打 **web 域**（不是任务列表走的
 * `product.endpoint`，也不存在 `/v2/.../reward/claim` 这个路径——打它恒 400
 * `task not completed`）。响应体 `{ code:0, data:{ already_claimed, credit, energy } }`。
 * 重复领取返回 `already_claimed:true`（幂等终态，不报错）。
 */
export async function claimGrowthTaskReward(credential, product, fetcher = fetch, taskCode) {
    // ⚠️ 必须在发请求前判空：空基址会拼出 `undefined/...` 或 `/activity/...`（相对路径），
    // 两者都能「发出去」，失败现象却指向服务端 —— 真因是本插件缺配置。
    const claimBase = claimBaseOf(product);
    if (claimBase.length === 0) {
        return {
            ok: false,
            claimed: false,
            credit: 0,
            message: '领取失败：产品配置缺少 claimBase（成长中心领奖站点），请检查 product.ts',
        };
    }
    try {
        const response = await fetcher(`${claimBase}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                ...minimalHeaders(credential, product),
                Accept: 'application/json, text/plain, */*',
                Origin: claimBase,
                Referer: `${claimBase}/profile/growth-center`,
                'x-client-platform': 'web',
            },
            body: '{}',
        });
        if (response.status === 401 || response.status === 403) {
            return {
                ok: false,
                claimed: false,
                credit: 0,
                message: `凭据已失效（HTTP ${response.status}）`,
            };
        }
        let payload;
        try {
            payload = JSON.parse(await response.text());
        }
        catch {
            return {
                ok: false,
                claimed: false,
                credit: 0,
                message: response.ok
                    ? `领取 ${taskCode} 响应无法解析`
                    : `领取 ${taskCode} 失败：HTTP ${response.status}`,
            };
        }
        if (typeof payload !== 'object' || payload === null) {
            return {
                ok: false,
                claimed: false,
                credit: 0,
                message: `领取 ${taskCode} 响应无法解析`,
            };
        }
        // ⚠️ 写端点的成功判据必须是**显式的 `code === 0`**，不能写成
        // `code !== undefined && code !== 0` —— 那样「响应里根本没有 code」会被
        // 当成成功，于是网关错误体（如 `{msg:'Unauthorized', status:401}` 这类
        // 非 0 但无 code 的形状）被谎报成「已领取奖励（+0 积分）」并计入
        // `claimedCount`。这与本文件 `classifyGrowthWrite`（写端点的权威分类器，
        // 缺 code 时归 -1 → failed）判据相反，是同一文件内的分叉。
        const code = typeof payload.code === 'number' ? payload.code : undefined;
        if (code !== 0) {
            const reason = readString(payload, 'msg');
            return {
                ok: false,
                claimed: false,
                credit: 0,
                message: `领取 ${taskCode} 失败：${reason.length > 0 ? reason : code === undefined ? '响应缺少 code 字段' : `code ${code}`}`,
            };
        }
        const data = typeof payload.data === 'object' && payload.data !== null
            ? payload.data
            : {};
        const credit = readNumber(data, 'credit');
        if (data['already_claimed'] === true) {
            return {
                ok: true,
                claimed: false,
                credit: 0,
                message: `${taskCode} 奖励已领取过（幂等，无新增积分）`,
            };
        }
        const energy = readNumber(data, 'energy');
        return {
            ok: true,
            claimed: true,
            credit,
            message: `已领取 ${taskCode} 奖励（+${credit} 积分${energy > 0 ? ` + ${energy} 能量` : ''}）`,
        };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            return { ok: false, claimed: false, credit: 0, message: `领取 ${taskCode} 超时` };
        }
        return {
            ok: false,
            claimed: false,
            credit: 0,
            message: `领取 ${taskCode} 失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * 上报一次 **web 域** 单事件（`POST {claimBase}/v2/report`）。
 * `Library_read`（资料库介绍点击）的完成判据在 web 侧事件流，桌面域 `/v2/report` 不计，
 * 故资料库类必须打 web 域。此处只发一条事件（eventCode/elementId/elementName 由调用方给）。
 */
async function reportWebEvent(credential, product, fetcher, eventCode, elementId, elementName) {
    // ⚠️ 用 `webBaseOf` 而非 `claimBaseOf`：本函数是 **web 遥测**（`/v2/report` +
    // 带 `Origin`/`Referer`），与领奖端点分属两站，配置项也不同。
    const webOrigin = webBaseOf(product);
    if (webOrigin.length === 0) {
        return { ok: false, message: 'web 事件上报失败：产品配置缺少 webBase / claimBase' };
    }
    const now = Date.now();
    const pageUrl = `${webOrigin}/space/d/${LIBRARY_SPACE_DOC_ID}`;
    const body = [{
            eventCode,
            timestamp: now,
            reportDelay: 0,
            pageURL: pageUrl,
            elementId,
            elementName,
            ...webPlatformIdentity(),
            userAgent: product.userAgent,
            machineId: sha256Hex(`webmachine:${credential.user_id}`).slice(0, 36),
            userId: String(credential.user_id ?? ''),
            userNickname: String(credential.nickname ?? ''),
            enterpriseId: String(credential.enterprise_id ?? ''),
        }];
    try {
        const response = await fetcher(`${webOrigin}/v2/report`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                ...minimalHeaders(credential, product),
                'x-client-platform': 'web',
                Origin: webOrigin,
                Referer: pageUrl,
            },
            body: JSON.stringify(body),
        });
        if (response.status === 401 || response.status === 403) {
            return { ok: false, message: `凭据已失效（HTTP ${response.status}）` };
        }
        if (!response.ok) {
            return { ok: false, message: `web 事件上报失败（HTTP ${response.status}）` };
        }
        return { ok: true, message: `web 事件 ${eventCode} 已上报` };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            return { ok: false, message: 'web 事件上报超时' };
        }
        return {
            ok: false,
            message: `web 事件上报异常：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * 设置外观主题（`POST /v2/user-asset/appearance/set`，kind=theme）。
 * `Hp_Appearance` 完成判据是桌面域 `appearance_skin_apply` 事件，但服务端要求主题已实际
 * 写入用户资产，故先调此接口落主题，再补一条 `appearance_skin_apply` 事件。
 */
async function setAppearanceTheme(credential, product, fetcher) {
    try {
        const response = await fetcher(`${baseOf(product)}/v2/user-asset/appearance/set`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { ...minimalHeaders(credential, product), 'x-client-platform': 'web' },
            body: JSON.stringify({ kind: 'theme', resource_key: APPEARANCE_THEME_KEY }),
        });
        if (response.status === 401 || response.status === 403) {
            return { ok: false, message: `凭据已失效（HTTP ${response.status}）` };
        }
        if (!response.ok) {
            return { ok: false, message: `外观设置失败（HTTP ${response.status}）` };
        }
        return { ok: true, message: `外观主题已设为 ${APPEARANCE_THEME_KEY}` };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            return { ok: false, message: '外观设置超时' };
        }
        return {
            ok: false,
            message: `外观设置异常：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * 发起一次**真实** SSE 对话（`POST /v2/chat/completions`），从响应体抓真实服务端 requestId。
 * `skill_1` / `Expert_lighthouse` 的判据要求事件 JOIN 到一条**真实**会话（编造 requestId 不计），
 * 故这两项必须先跑本函数拿真 requestId，再交给 `reportTaskEvents` 上报事件链。
 * 读完整 SSE 正文并正则抓 32 位 hex id（对齐 Go 侧 idRegex）。
 */
async function chatRealSession(credential, product, fetcher, expertId, model = FAST_MODEL) {
    const body = {
        model,
        messages: [
            { role: 'system', content: '当前处于中文环境，请使用简体中文回答。' },
            { role: 'user', content: '1+1等于几？直接回答。' },
        ],
        agent: 'cli',
        temperature: 1,
        stream: true,
        stream_options: { include_usage: true },
    };
    try {
        const response = await fetcher(`${baseOf(product)}/v2/chat/completions`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                ...minimalHeaders(credential, product),
                Accept: 'text/event-stream',
                'X-Conversation-ID': `jb-conv-${Date.now()}`,
                'X-Request-ID': String(Date.now()),
                'X-Expert-Id': expertId,
                'X-Agent-Intent': 'craft',
                'X-Agent-Type': 'main',
            },
            body: JSON.stringify(body),
        });
        if (response.status === 401 || response.status === 403) {
            return { ok: false, requestId: '', message: `凭据已失效（HTTP ${response.status}）` };
        }
        if (!response.ok) {
            return { ok: false, requestId: '', message: `真实对话请求失败（HTTP ${response.status}）` };
        }
        // 读完整 SSE 流并从正文抽真实 id（`"id":"<32hex>"`）。
        const text = await response.text();
        const idMatch = text.match(/"id"\s*:\s*"((?:cmb-)?[0-9a-f]{32})"/);
        if (!idMatch) {
            return {
                ok: false,
                requestId: '',
                message: '真实对话未返回可用 requestId（服务端未派发 id）',
            };
        }
        return {
            ok: true,
            requestId: idMatch[1],
            message: `真实对话完成（requestId=${idMatch[1]}）`,
        };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
            return { ok: false, requestId: '', message: '真实对话超时' };
        }
        return {
            ok: false,
            requestId: '',
            message: `真实对话异常：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/** 夜猫子任务的服务端计入窗口：23:00–08:00。 */
function isGrowthNightWindow(date = new Date()) {
    const hour = date.getHours();
    return hour >= 23 || hour < 8;
}
/** 客户端专属任务：完成判据在客户端 UI（微信动作），事件上报推不动，如实降级。 */
const CLIENT_ONLY_TASK_CODES = new Set(['wb_wechat_oa_subscribe_task', 'wechat_linked']);
/**
 * 「养虾等级」任务族中**判据结构性不可达**的 4 项。
 *
 * 这族任务的第二端点（`/activity/growth/tasks`）不返回 `progress`，只返回
 * `status`（`available` = 未达成）。事件上报改变不了 `status` —— 实测 2 轮 ×
 * 3 个账号共 6 次，`first_chat` / `template_used` / `expert_summoned` /
 * `skill_installed` 的 `status` 始终 `available`，`progress` 视图恒为 0/1。
 *
 * 据此**跳过「真实会话 + 真 requestId」重试**：那一次重试要发一条真实对话
 * （消耗 token 与活跃记录）再等 4s 结算，而结果已确定不会变。多账号时会累积成
 * 明显的无效请求与风控面。合成事件仍照发一次，保留判据万一改版的可能。
 *
 * ⚠️ 这不是「做不到」的断言，而是「当前服务端口径下事件不计数」。若日后
 * `status` 也接受事件驱动，此处的短路应同步撤掉。
 */
const LEVEL_UNREACHABLE_TASK_CODES = new Set([
    'first_chat',
    'template_used',
    'expert_summoned',
    'skill_installed',
]);
/** 专家类任务：判据要求真实 expert_id，且服务端按 expert_id 按天去重。 */
function isExpertTaskCode(code) {
    return (code === 'expert_5' ||
        code === 'Expert_team_use_3' ||
        code === 'Expert_lighthouse' ||
        code === 'expert_summoned');
}
/** 按任务判据对齐的缺省模型；`undefined` 表示走通用模型。 */
function modelForTaskCode(code) {
    if (code === 'Model_chat_GLM5.2' || code === 'black_cat') {
        return GLM_MODEL_ID;
    }
    if (code === 'RichMeow_Chat' ||
        code === 'first_chat' ||
        code === 'template_used' ||
        code === 'expert_summoned') {
        return FAST_MODEL;
    }
    return undefined;
}
/** 读某个任务码的当前进度（缺失即 0/1）。 */
async function readProgress(credential, product, fetcher, code) {
    const after = await fetchGrowthTaskCodes(credential, product, fetcher, {
        includeInProgress: true,
    });
    const prog = after.ok ? after.progressByCode?.[code] : undefined;
    return { current: prog?.current ?? 0, target: prog?.target ?? 1 };
}
/**
 * 执行**全量任务完成动作**（默认路径的完整档）。
 *
 * 编排（串行，防风控）：
 *   1. 拉任务列表，筛「白名单 ∩ not_accepted ∩ GROWTH_TASK_COMPLETION 可达」；
 *   2. 接取这些任务（`accept`）；
 *   3. 逐项执行完成动作（`canvas` 建会话 / `chat` 发消息 / `canvasThenChat` 两者）；
 *   4. 扫尾补领所有「已达标未领取」的任务。
 *
 * ⚠️ 与 {@link claimAllGrowth}（只接取 + 旅行领奖，副作用最小）的区别：本函数
 * **真正执行完成动作**，会建会话 / 发消息（消耗少量 token 与活跃记录）。
 * 串行 + 单账号 + 白名单限定控制风控。
 */
export async function runGrowthTaskCompletions(credential, product, fetcher = fetch, options = {}) {
    /**
     * ⚠️ 缺 `user_id` 必须**显式留痕**，不能静默跑完。
     *
     * 判据事件里的 `userId` / `machineId` 全部由 `credential.user_id` 派生
     * （见 `desktopFingerprint` / `reportWebEvent`）：uid 为空时 `userId` 上报空串、
     * `machineId` 退化成 `sha256('machine:')` —— 按用户维度计数的判据**必然不计数**，
     * 而代码不报错、接口不报错，表现为「跑完一圈 0 项完成」，用户完全无从排查。
     *
     * 不直接返回失败：仍有不依赖 uid 的服务端逻辑（接取、部分任务），
     * 直接放弃会连那些也丢掉。故只把原因写进 message 让用户看见。
     */
    const missingUserId = !credential.user_id;
    if (missingUserId) {
        console.warn('[buddy-growth] 凭据缺少 user_id：判据事件里的 userId/machineId 将退化，'
            + '任务大概率不被服务端计数。请重新登录该账号。');
    }
    // 取「白名单可达 ∩ 未完成（not_accepted + in_progress）」的 task_code。
    // 接取（accept）把任务从 not_accepted 置 in_progress，完成动作必须在
    // in_progress 上再触发一次才判完成并发积分 —— 不能只看 not_accepted。
    const unfinished = await fetchGrowthTaskCodes(credential, product, fetcher, {
        includeInProgress: true,
    });
    if (!unfinished.ok) {
        /**
         * ⚠️ 必须把失败原因**也放进 `results`**（用 `unfinished.message`，其中
         * 401/403 会说「凭据已失效」），不能只写在 `message` 里。
         *
         * 下游 `collectBuddyGrowth`（`jet-hub-rpc.ts`）判僵尸账号的依据是
         * **逐项** `results.some(r => /凭据已失效/.test(r.message))`。此处若返回空
         * `results`，凭据失效就判不出来 ⇒ `expired=false` ⇒ 既不计 failed 也不写
         * error ⇒ 前端显示「本轮无 API 可达的任务（未领到积分）」，
         * **把「请重新登录」说成「没有任务」**，用户完全无从排查。
         */
        const reason = unfinished.message ?? '任务列表查询失败';
        return {
            ok: false, results: [{ taskCode: '', ok: false, message: reason }],
            completed: 0, clientOnly: 0, failed: 0,
            claimedCount: 0, claimedCredit: 0, timedOut: false,
            message: reason,
        };
    }
    const actionable = unfinished.codes.filter((code) => GROWTH_TASK_COMPLETION[code] !== undefined);
    const results = [];
    /** `actionable` 为空时仍须走扫尾（见下方块尾注释），此处只用于最终文案。 */
    const noActionableTasks = actionable.length === 0;
    let completed = 0;
    let failed = 0;
    let clientOnly = 0;
    const progressByCode = unfinished.progressByCode ?? {};
    // 预算**必须在此处**算好：扫尾补领受同一 deadline 约束，若等到逐项完成阶段
    // 才计算，则 `actionable` 为空时扫尾会绕过预算直接对全量任务逐个 POST。
    // 非有限值（NaN / Infinity）归为「不限」并留痕：Number('abc') 得 NaN，而
    // NaN > 0 为 false，若不显式区分会静默变成不限时，恰是本预算要防的情况。
    const rawBudget = options.budgetMs === undefined ? DEFAULT_BUDGET_MS : Number(options.budgetMs);
    const budgetInvalid = !Number.isFinite(rawBudget);
    const budgetMs = budgetInvalid ? 0 : rawBudget;
    const deadlineAt = budgetMs > 0 ? Date.now() + budgetMs : undefined;
    if (budgetInvalid) {
        console.warn(`[buddy-growth] budgetMs=${String(options.budgetMs)} 非有限值，本轮不限时`);
    }
    let timedOut = false;
    // 接取这批里仍 not_accepted 的（in_progress 的跳过 accept，幂等）
    const toAccept = unfinished.toAccept
        ? actionable.filter((code) => unfinished.toAccept?.has(code))
        : actionable;
    const acceptResult = toAccept.length
        ? await postGrowthJson(GROWTH_TASK_ACCEPT_PATH, credential, product, { task_codes: toAccept }, fetcher)
        : { ok: true, status: 200, body: { code: 0 } };
    const accept = classifyGrowthWrite(acceptResult);
    // 接取失败：逐项记为失败，但**仍继续走扫尾** —— 接取失败只影响「本轮新接的
    // 任务」，账号里已达标未领取的奖励与接取无关，不该被它连带跳过。
    // （早期实现此处直接 return，于是接取一失败就整轮不领奖。）
    const acceptFailed = accept.state === 'failed';
    if (acceptFailed) {
        for (const code of actionable) {
            results.push({ taskCode: code, ok: false, message: `接取失败：${accept.message}` });
        }
        failed += actionable.length;
    }
    // 接取失败 ⇒ 任务未进入 in_progress，完成动作无从生效，故跳过逐项阶段。
    // `actionable` 为空时它自然也是空数组（上面的 accept 分支已用三元兜住不发请求）。
    const completable = acceptFailed ? [] : actionable;
    // 专家类先拉市场真实专家列表（编造 id 不计数；服务端按 expert_id 去重，
    // 同 id 同天只计一次，故 expert_5 需 5 个**不同**专家各用一次，故拉整份列表轮换）。
    // expert_summoned 也要真实专家 id —— 它与 expert_5 同一条召唤链。
    let expertAgentList = [];
    let expertTeamList = [];
    if (actionable.some(isExpertTaskCode)) {
        const agentRes = await fetchMarketExpertList(credential, product, fetcher, 'agent');
        if (agentRes.ok) {
            expertAgentList = agentRes.experts;
        }
        const teamRes = await fetchMarketExpertList(credential, product, fetcher, 'team');
        if (teamRes.ok) {
            expertTeamList = teamRes.experts;
        }
    }
    // 串行逐项完成（单账号，防风控）
    for (const code of completable) {
        const spec = GROWTH_TASK_COMPLETION[code];
        let ok = false;
        let clientOnlyFlag = false;
        let message = '';
        /**
         * ⚠ spec 缺失必须**兜住而不是崩**：`AUTOMATABLE_TASK_CODES` 与
         * `GROWTH_TASK_COMPLETION` 是两张手工维护的表，前者有码而后者漏写时
         * `spec.kind` 会抛 TypeError，把**整轮**领取连带其它账号一起炸掉。
         */
        if (spec === undefined) {
            results.push({
                taskCode: code,
                ok: false,
                message: '无完成动作实现（AUTOMATABLE_TASK_CODES 有它但 GROWTH_TASK_COMPLETION 漏写）',
            });
            failed += 1;
            continue;
        }
        // ⚠ 预算耗尽就**如实停在这里**：剩下每一项的真实完成动作都可能包含真实
        // 对话与多次复查，硬跑完会让整轮 RPC 悬到宿主超时（超时上限由
        // dsh-credentials 的 rpc 层决定，本插件不可见也不可控）—— 表现是用户点一次
        // 按钮、长时间无响应、最后失败，而前面已完成的项的积分虽已到账却看不到回执。
        // 宁可「少做几项 + 如实报出哪几项没做」，也不要「卡死到超时」。
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
            timedOut = true;
            const remain = actionable.slice(actionable.indexOf(code));
            for (const pending of remain) {
                results.push({
                    taskCode: pending,
                    ok: false,
                    message: '本轮时间预算已用尽，未执行（点一次按钮可继续）',
                });
            }
            failed += remain.length;
            break;
        }
        // 养虾等级族：判据是服务端 `status` 而非 progress 计数，事件推不动（见该常量
        // 注释）。**在分派之前**短路，才能同时覆盖 `chat` 与 `skillFresh` 两种 kind ——
        // 后者的真实会话写在分支开头，只在 chat 分支里拦不住。
        if (LEVEL_UNREACHABLE_TASK_CODES.has(code)) {
            ok = true;
            clientOnlyFlag = true;
            message = `${code} 的判据由服务端 status 记录（非 progress 计数），API 事件不改变它；需在客户端真实完成`;
            results.push({ taskCode: code, ok, message, clientOnly: true });
            clientOnly += 1;
            await new Promise((resolve) => setTimeout(resolve, TASK_INTERVAL_MS));
            continue;
        }
        try {
            switch (spec.kind) {
                case 'canvas':
                case 'canvasThenChat': {
                    // 判据是 wbx_design_canvas_* 遥测事件，故不建真实画布（避免在账号里堆画布）。
                    const canvas = await reportTaskEvents(credential, product, fetcher, code, 1, {});
                    if (!canvas.ok) {
                        message = canvas.message;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
                    const progress = await readProgress(credential, product, fetcher, code);
                    if (progress.current >= progress.target) {
                        ok = true;
                        const claim = await claimGrowthTaskReward(credential, product, fetcher, code);
                        message = `${canvas.message}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`;
                    }
                    else {
                        ok = true;
                        clientOnlyFlag = true;
                        message = `${canvas.message}，progress ${progress.current}/${progress.target} 未涨，需在设计创意模式真实建一次画布`;
                    }
                    break;
                }
                case 'chat': {
                    if (CLIENT_ONLY_TASK_CODES.has(code)) {
                        clientOnlyFlag = true;
                        ok = true; // 已尝试触达，但积分需客户端动作
                        message = '需客户端完成（API 无法推进此任务进度）';
                        break;
                    }
                    // 夜猫子仅在服务端 23:00–08:00 计入，窗口外如实标注而不谎报已发。
                    if (code === 'black_cat' && !isGrowthNightWindow()) {
                        clientOnlyFlag = true;
                        ok = true;
                        message = `夜猫子仅在 23:00–08:00 计入，当前 ${new Date().getHours()} 点不在窗口内（未上报，窗口内点一次即可自动补足 3 次）`;
                        break;
                    }
                    // 轻量云专家判据绑定**固定** expert_id（市场里任取专家不计数），且召唤链与
                    // 使用链必须分两次上报，故单列不走通用轮询。
                    if (code === 'Expert_lighthouse') {
                        const fixed = {
                            expertId: LIGHTHOUSE_EXPERT_ID,
                            expertType: 'agent',
                            name: LIGHTHOUSE_EXPERT_NAME,
                            title: LIGHTHOUSE_EXPERT_NAME,
                            version: '1.0.2',
                        };
                        const lighthouse = expertAgentList.find((e) => e.expertId === fixed.expertId) ?? fixed;
                        const session = await chatRealSession(credential, product, fetcher, lighthouse.expertId);
                        if (!session.ok) {
                            message = `轻量云专家真实会话失败：${session.message}`;
                            break;
                        }
                        const lhConv = `jb-conv-${session.requestId}`;
                        const summonRes = await reportDesktopEvents(credential, product, fetcher, expertEventChain(lighthouse, lhConv, session.requestId, product).slice(0, 3), lhConv, session.requestId);
                        if (!summonRes.ok) {
                            message = summonRes.message;
                            break;
                        }
                        const chatWithExpert = chatEventChain(FAST_MODEL, lhConv, session.requestId).map((e) => e.eventCode === DESKTOP_EVENT_ORDER[0]
                            ? {
                                ...e,
                                has_expert: true,
                                expert_id: lighthouse.expertId,
                                expert_name: lighthouse.name,
                                expert_industry_id: '',
                            }
                            : e);
                        chatWithExpert.push({
                            eventCode: 'expert_actual_use', id: lighthouse.expertId, name: lighthouse.name,
                            expertType: lighthouse.expertType, conversationId: lhConv,
                            requestId: session.requestId,
                            inputToken: 120, outputToken: 80, totalToken: 200,
                            isSuccessful: true, mode: 'LOCAL', type: '', cost: 0,
                        });
                        const useRes = await reportDesktopEvents(credential, product, fetcher, chatWithExpert, lhConv, session.requestId);
                        if (!useRes.ok) {
                            message = useRes.message;
                            break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
                        const progress = await readProgress(credential, product, fetcher, code);
                        const done = `${session.message}；${summonRes.message} + ${useRes.message}`;
                        if (progress.current >= progress.target) {
                            ok = true;
                            const claim = await claimGrowthTaskReward(credential, product, fetcher, code);
                            message = `${done}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`;
                        }
                        else {
                            ok = true;
                            clientOnlyFlag = true;
                            message = `${done}，progress ${progress.current}/${progress.target} 未涨，需在客户端真实体验轻量云专家`;
                        }
                        break;
                    }
                    // 按 progress.target 补次数：还差几条发几条（不同会话各计一次）。
                    // 专家类：服务端按真实 expert_actual_use 事件逐轮计数，单轮未必补满，
                    // 故多轮补到 target 或无法再涨为止。
                    const prog = progressByCode[code] ?? { current: 0, target: 1 };
                    const remaining = Math.max(1, prog.target - prog.current);
                    const isExpert = isExpertTaskCode(code);
                    const model = modelForTaskCode(code);
                    // 专家类：每轮换一个**不同**专家（服务端按 expert_id 去重，同 id 同天只计一次），
                    // 列表不够时回到首个。非专家类传空 expert。
                    const expertList = code === 'Expert_team_use_3'
                        ? expertTeamList
                        : code === 'Expert_lighthouse'
                            ? expertAgentList
                            : code === 'expert_5' || code === 'expert_summoned'
                                ? expertAgentList
                                : [];
                    // 服务端按 expert_id 去重（同 id 当天只计一次），故 remaining=1 时也要换不同
                    // 专家连试，直到 progress 上涨或专家用尽。
                    const maxRounds = isExpert
                        ? Math.min(Math.max(remaining, 3), Math.max(1, expertList.length))
                        : 1;
                    let reportedTotal = 0;
                    let nowCurrent = prog.current;
                    let targetNow = prog.target;
                    let lastReport = { ok: true, reported: 0, message: '' };
                    for (let roundNo = 0; roundNo < maxRounds; roundNo++) {
                        const thisRemaining = Math.max(1, targetNow - nowCurrent);
                        lastReport = await reportTaskEvents(credential, product, fetcher, code, thisRemaining, expertList.length > 0
                            ? { expert: expertList[roundNo % expertList.length] }
                            : {});
                        if (!lastReport.ok) {
                            message = lastReport.message;
                            break;
                        }
                        reportedTotal += lastReport.reported;
                        // 复查 progress，未达标且还有轮次则继续补
                        const progress = await readProgress(credential, product, fetcher, code);
                        nowCurrent = progress.current;
                        targetNow = progress.target;
                        if (nowCurrent >= targetNow) {
                            break;
                        }
                        if (roundNo < maxRounds - 1) {
                            await new Promise((resolve) => setTimeout(resolve, ROUND_INTERVAL_MS));
                        }
                    }
                    if (!lastReport.ok) {
                        message = lastReport.message;
                        break;
                    }
                    if (nowCurrent >= targetNow) {
                        ok = true;
                        // progress 达标 → 自动领取奖励（免手动点击到账）。
                        const claim = await claimGrowthTaskReward(credential, product, fetcher, code);
                        message = `已上报 ${reportedTotal} 条事件，progress 达标（${nowCurrent}/${targetNow}）；${claim.message}`;
                        break;
                    }
                    /**
                     * 合成事件链没推进 ⇒ 改用**真实会话 + 真实 requestId** 再试一次。
                     *
                     * ⚠⚠ 顺序不可换：只发一次真实对话（不带它的 requestId）不算数 ——
                     * 服务端按「事件 JOIN 到真实会话」计数，没有真 requestId 的事件链不被认，
                     * 于是合成链不涨、真实对话也不涨，任务被误判成「需客户端」。
                     * `Model_chat_GLM5.2` 就是这样被判成 clientOnly 的：它在旧账号上早于
                     * 本实现就已领取，所以从没有机会暴露出「合成链推不动它」。
                     * `skill_1` 走的是真 requestId 路径，所以它能成 —— 同一个机制，
                     * 当时只给 skill_1 用了。
                     */
                    const realModel = model ?? FAST_MODEL;
                    const session = await chatRealSession(credential, product, fetcher, '', realModel);
                    if (!session.ok) {
                        // 连真实会话都拿不到 requestId（凭据/端点/限频）⇒ 如实报失败，
                        // 不能报 clientOnly —— 那会把「服务端不可达」说成「要用户手动做」。
                        message = `已上报 ${reportedTotal} 条事件，真实会话失败：${session.message}`;
                        break;
                    }
                    const realReport = await reportTaskEvents(credential, product, fetcher, code, Math.max(1, targetNow - nowCurrent), {
                        conversationId: `jb-${session.requestId}`,
                        requestId: session.requestId,
                        model: realModel,
                    });
                    if (!realReport.ok) {
                        message = realReport.message;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
                    const settled = await readProgress(credential, product, fetcher, code);
                    if (settled.current >= targetNow) {
                        ok = true;
                        const claim = await claimGrowthTaskReward(credential, product, fetcher, code);
                        message = `${session.message}；${realReport.message}，progress 达标（${settled.current}/${targetNow}）；${claim.message}`;
                    }
                    else {
                        // 真实会话 + 真 requestId 仍不涨 ⇒ 这次是真的推不动，如实归 clientOnly。
                        ok = true;
                        clientOnlyFlag = true;
                        message = `已上报 ${reportedTotal} 条合成事件 + 真实会话(${realModel})，progress ${settled.current}/${targetNow} 仍未涨`;
                    }
                    break;
                }
                case 'webClick': {
                    // Library_read：资料库介绍点击，判据在 web 域事件流（elementId 固定
                    // library_doc_intro_click，页面为资料库空间）。
                    const webRes = await reportWebEvent(credential, product, fetcher, 'web_element_click', 'library_doc_intro_click', 'WorkBuddy资料库介绍');
                    if (!webRes.ok) {
                        message = webRes.message;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
                    const progress = await readProgress(credential, product, fetcher, code);
                    if (progress.current >= progress.target) {
                        ok = true;
                        const claim = await claimGrowthTaskReward(credential, product, fetcher, code);
                        message = `${webRes.message}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`;
                    }
                    else {
                        ok = true;
                        clientOnlyFlag = true;
                        message = `${webRes.message}，progress ${progress.current}/${progress.target} 未涨，需在资料库页手动点一次介绍`;
                    }
                    break;
                }
                case 'appearance': {
                    // Hp_Appearance：先落主题资产，再补桌面域 appearance_skin_apply 事件。
                    const theme = await setAppearanceTheme(credential, product, fetcher);
                    if (!theme.ok) {
                        message = theme.message;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, APPEARANCE_SETTLE_MS));
                    const report = await reportTaskEvents(credential, product, fetcher, code, 1, {});
                    if (!report.ok) {
                        message = report.message;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
                    const progress = await readProgress(credential, product, fetcher, code);
                    const done = `${theme.message} + ${report.message}`;
                    if (progress.current >= progress.target) {
                        ok = true;
                        const claim = await claimGrowthTaskReward(credential, product, fetcher, code);
                        message = `${done}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`;
                    }
                    else {
                        ok = true;
                        clientOnlyFlag = true;
                        message = `${done}，progress ${progress.current}/${progress.target} 未涨，需在设置页切一次主题`;
                    }
                    break;
                }
                case 'skillFresh': {
                    // skill_1：判据是 skill_info 事件 JOIN 到真实 fast-model 会话，
                    // 故先取服务端真实 requestId，再以其为根上报对话链 + skill_info。
                    const session = await chatRealSession(credential, product, fetcher, '');
                    if (!session.ok) {
                        message = session.message;
                        break;
                    }
                    // ⚠ `fast-model` 写死而非取变量：skill_info 判据只认 fast-model 会话。
                    // skill_installed（等级族）与 skill_1（成长族）共用 skill_info 判据。
                    const report = await reportTaskEvents(credential, product, fetcher, code, 1, { requestId: session.requestId, model: FAST_MODEL });
                    if (!report.ok) {
                        message = report.message;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
                    const progress = await readProgress(credential, product, fetcher, code);
                    const done = `${session.message} + ${report.message}`;
                    if (progress.current >= progress.target) {
                        ok = true;
                        const claim = await claimGrowthTaskReward(credential, product, fetcher, code);
                        message = `${done}，progress 达标（${progress.current}/${progress.target}）；${claim.message}`;
                    }
                    else {
                        ok = true;
                        clientOnlyFlag = true;
                        message = `${done}，progress ${progress.current}/${progress.target} 未涨，需在客户端真实调用一次技能`;
                    }
                    break;
                }
            }
        }
        catch (error) {
            /**
             * 单个任务的异常（代码缺陷 / 端点返回意外形状）**只记该项失败**，
             * 不得中断整轮 —— 否则一个任务出问题会让所有账号、所有任务一起失败，
             * 用户只看到一个 `失败 — <内部异常>`，完全无从判断是哪一项。
             */
            message = `完成动作异常：${error instanceof Error ? error.message : String(error)}`;
        }
        results.push({
            taskCode: code,
            ok,
            message,
            ...(clientOnlyFlag ? { clientOnly: true } : {}),
        });
        if (ok && !clientOnlyFlag) {
            completed += 1;
        }
        else if (!ok) {
            failed += 1;
        }
        if (clientOnlyFlag) {
            clientOnly += 1;
        }
        // 串行节流：任务间留缓冲。
        await new Promise((resolve) => setTimeout(resolve, TASK_INTERVAL_MS));
    }
    // ── 扫尾：对所有「已达标未领取」的任务补领（网页显示可领取 = 服务端已判完成，
    //    此时 claim 端点直接到账，无需依赖我推 progress 的数值）。幂等：已领过返回
    //    already_claimed，不重复计分。
    let claimedCount = 0;
    let claimedCredit = 0;
    {
        // 扫尾覆盖**全量**任务 code（含已完成未领的），不只 not_accepted 子集。
        const allCodes = await listAllGrowthTaskCodes(credential, product, fetcher);
        for (const code of allCodes) {
            // 扫尾同样受时间预算约束：allCodes 长度由服务端决定，无上限，
            // 每项一次 POST + 1s sleep，超时未检查会撞上宿主 RPC 超时。
            if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
                timedOut = true;
                const remaining = allCodes.length - allCodes.indexOf(code);
                console.warn(`[buddy-growth] 扫尾补领在时间预算处停止，剩余 ${remaining} 项未执行`);
                results.push({
                    taskCode: code,
                    ok: false,
                    // ⚠️ 文案必须与逐项阶段的「未执行」用**同一个词**：这条断言
                    // （`message` 含「未执行」）是回归用例判据，两处一旦分叉，
                    // 扫尾分支就没有测试覆盖了。
                    message: `扫尾补领触及时间预算，本轮还有 ${remaining} 项未执行；再点一次即可继续`,
                });
                failed += 1;
                break;
            }
            const claim = await claimGrowthTaskReward(credential, product, fetcher, code);
            if (claim.ok && claim.claimed) {
                claimedCount += 1;
                claimedCredit += claim.credit;
            }
            await new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS));
        }
    }
    const hasActivity = completed > 0 || failed > 0 || clientOnly > 0 || claimedCount > 0;
    /** 缺 uid 的提示（拼在末尾，无论有无活动都要出现 —— 否则正是「静默」）。 */
    const uidHint = missingUserId
        ? '；⚠️ 凭据缺少 user_id，判据事件可能不被服务端计数，请重新登录该账号'
        : '';
    return {
        ok: failed === 0,
        results,
        completed,
        clientOnly,
        failed,
        claimedCount,
        claimedCredit,
        timedOut,
        ...(hasActivity
            ? {
                message: `完成 ${completed} 项，需客户端 ${clientOnly} 项，失败 ${failed} 项，自动领取 ${claimedCount} 项（+${claimedCredit} 积分）${timedOut ? '；本轮时间预算用尽，剩余项未执行，再点一次即可继续' : ''}${uidHint}`,
            }
            : // 无活动：区分「本来就没有可完成任务」与「扫尾领到了但逐项阶段没做」
                // —— 后者说明账号里只有已达标未领的奖励，是正常终态。
                noActionableTasks
                    ? { message: `无 API 可达的待完成任务${uidHint}` }
                    : { ...(uidHint.length > 0 ? { message: uidHint.replace(/^；/, '') } : {}) }),
    };
}
//# sourceMappingURL=buddy-growth.js.map