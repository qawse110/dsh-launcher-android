/**
 * ZCode 的阿里云 captcha 产出（**唯一还需要浏览器的环节，但只服务 claim 路径**）。
 *
 * ## 谁还要 captcha（2026-10-01 直连上游实测，别再凭印象改）
 *
 * | 端点 | 不带验证头 | 结论 |
 * |---|---|---|
 * | `/api/v1/zcode-plan/anthropic`（**模型请求**） | **HTTP 200**（6 个采样点） | **自 3.14.4（2026-09-29）起不再索要** |
 * | `/api/v1/zcode-plan/billing/claim`（**领取**） | `400 {"code":3007}` | **始终索要**，且校验**前置于** plan 校验 |
 *
 * ⇒ 模型请求这条路现在**恒不产** param（`src/captcha-requirement.ts` 的
 * 「先探后取」使 mint 次数归零）；仍在产的是**领取**（每日一次 / 手动点「一键领取」，
 * **每个 plan 独立一个**，一次性，复用必 `3007`）。
 * ⚠ 模型请求侧的 `3007` 防御分支**故意保留**：万一上游回滚再开校验，推理请求仍能自愈，
 * 而不是把失败抛给用户。
 *
 * ## 载体：web 版必需浏览器，桌面版可用内部载体
 * captcha 是**网页 SDK**（`o.alicdn.com/.../AliyunCaptcha.js`），任何有 DOM 能跑 JS 的
 * 浏览器都能产。本文件这套外挂 chromium 路径是 **web 版的必需项**；
 * DSH Desktop 下会优先用**桌面自己的 Electron 内核**（`dshDesktop.browser` 租约 +
 * 隐藏 `<webview>` + `executeJavaScript`，见 `src/captcha-carrier.ts`），
 * 本文件退为其**兜底**（`DSH_ZCODE_INTERNAL_CARRIER=0` 可强制只用它）。
 *
 * ## 为什么能用普通浏览器而不是 ZCode 那个壳
 *
 * captcha 是**网页 SDK**，不是 Electron 专有 API：
 *
 * ```
 * script:  https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
 * config:  window.AliyunCaptchaConfig = { region, prefix }
 * 调用:    initAliyunCaptcha({ SceneId, mode, element, button, getInstance, success, … })
 * 取参:    getInstance 里调 instance.startTracelessVerification()（无感验证）
 *          → success(param) 回调给出 param
 * ```
 *
 * 故任何「有 DOM + canvas + 能跑 JS」的浏览器都行。实测
 * **scoop 的 chromium（headful + 基本 stealth 补丁）** 可稳定产出。
 *
 * ## ⚠ 两个实测得到的约束（第 1 条后来**被推翻**，结论以第 2 条为准）
 *
 * ### 1. ~~同一个页面**不能**重复 mint~~ → **已推翻**（当时页面停在 `about:blank`）
 *
 * 同一 page 上连续 `initAliyunCaptcha` 三次的实测结果：
 *
 * | 次序 | 结果 | 耗时 |
 * |---|---|---|
 * | #1 | ✓ len=280 | 817ms |
 * | #2 | ✗ `F001` | 279ms |
 * | #3 | ✗ `F001` | 296ms |
 *
 * ⇒ SDK 实例状态在页面内不可重复初始化。**每次 mint 必须新建 page target**。
 * 采用该策略后实测 **4/4 成功，中位 1246ms**（浏览器冷启动仅 690ms）。
 *
 * ⚠⚠ **上面那两行是当时的结论，现在别再照着做**：真正的变量是页面 origin ——
 * 那三次是在 `about:blank`（origin 为字符串 `"null"`）上跑的。换到真实
 * `https://zcode.z.ai/` 后同一页面可**连续 mint 5/5**，中位 426ms / 平均 546ms，
 * 现行实现因此**复用常驻页面 + 每次重置 DOM**。证据与推理见
 * {@link CAPTCHA_PAGE_ORIGIN}；上面的表保留仅作原始记录（改回去会让耗时翻 2.3 倍）。
 *
 * ### 2. `--headless=new` 过不了，必须 **headful**
 *
 * | 模式 | 结果 |
 * |---|---|
 * | `--headless=new`（+ 补丁） | ✗ `fail` / `verifyCode: F001` |
 * | **headful + 补丁** | ✓ 280 字符合法 param |
 *
 * 阿里云风控会看这个差异。headful 在 Windows 上可以**不打扰用户**
 * （`--window-position=-32000,-32000` 移出屏幕）。
 */
import { homedir } from 'node:os';
import { CdpConnection, ChromiumSession, sleep } from './chromium-session.js';
/**
 * 浏览器侧通用件**已搬到 `./chromium-session.js`**（库库AI 的登录注册也复用它）。
 *
 * ⚠️ 这里**必须继续 re-export**，两条理由各管一件事：
 * 1. 既有调用方（`zcode-auth.ts` / `zcode-adapter.ts` 等）与一批回归用例
 *    是按 `./zcode-captcha.js` 这个路径 import 的，砍掉导出面等于改 API；
 * 2. 源码扫描型用例（拿 `readFileSync` 读源码做断言的那些）已改为指向
 *    `chromium-session.ts` —— 那是**代码真正所在**的文件，否则断言会打空、
 *    变成假绿。
 */
export { browserCandidates, browserNotFoundMessage, buildLinuxSkipTaskbarArgs, buildMacosMiniaturizeArgs, findBrowserExecutable, isBrowserDeploymentError, isEdgeExecutable, parseWmctrlList, } from './chromium-session.js';
/**
 * 上游是否**明确要求**推理请求带 captcha —— 即「首发就该带，别再先探」。
 *
 * ## 三态（这是本判据的全部要点，别简化成布尔）
 *
 * | `skipModelRequest` | `enabled` | 返回 | 理由 |
 * |---|---|---|---|
 * | **`false`** | 非 `false` | **`true`** | 上游明确要 ⇒ 先探**必然**被 `3007` 拒，白吃一发往返 |
 * | `true` | 非 `false` | `false` | 上游明确不校验 ⇒ 先探零成本，且能省掉一次 mint |
 * | **缺席 / 非布尔** | 任意 | `false` | **不知道就不猜** |
 * | 任意 | **`false`** | `false` | 上游把 captcha 整个关了 ⇒ 一票否决 |
 *
 * ## ⚠⚠ 两个最容易写反的地方
 *
 * 1. **方向**：能省的是 `skipModelRequest === false`（明确要 ⇒ 直接带），
 *    **不是** `true`。`true` 表示上游不校验，先探本来就零成本、无可省。
 * 2. **缺席 ≠ `false`**：若写成 `skipModelRequest !== true` 或
 *    `Boolean(skipModelRequest === false)` 之类的宽松判据，就会在
 *    **老配置 / 上游字段漂移**时把「不知道」当成「上游明确要验证」，
 *    于是**每个请求白发一个 param** —— 白扣的是阿里云**设备级**配额
 *    （同设备每小时 150 次，实测口径见 `captcha-backoff.ts`）。
 *    这正是本仓库记过的「读不到就不猜」原则（同额度桶那条）。
 *
 * ⚠ 判据**只读配置**，不发网络、不碰浏览器 ⇒ 可以在热路径上每次调用。
 */
export function requiresCaptchaUpfront(config) {
    if (config === undefined)
        return false;
    // 上游把 captcha 整个关掉时，无论 skip_model_request 是什么都不该带。
    if (config.enabled === false)
        return false;
    // ⚠ 严格等于 `false`：`undefined`（缺席）走不到这里 ⇒ 保守回到先探。
    return config.skipModelRequest === false;
}
/**
 * 兜底 captcha 配置。
 *
 * ⚠ 这些值**实测自本机账号**（`GET /api/v1/client/configs?platform=unknown`
 * 的 `data.configs.captcha`）。理论上可能随账号/灰度变化，故
 * `ZcodeAuth.fetchCaptchaConfig()` 会优先向服务端索取，此处仅作兜底。
 */
export const ZCODE_CAPTCHA_FALLBACK = {
    region: 'cn',
    prefix: 'no8xfe',
    sceneId: '11xygtvd',
};
/** 阿里云 captcha SDK 地址（与官方逐字一致）。 */
export const ALIYUN_CAPTCHA_SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
/** SDK 需要的 DOM 宿主 id（与官方 `zcode-aliyun-captcha-*` 一致）。 */
export const CAPTCHA_CONTAINER_ID = 'zcode-aliyun-captcha-container';
/** 挂载点 id。 */
export const CAPTCHA_ELEMENT_ID = 'zcode-aliyun-captcha-element';
/** 按钮 id。 */
export const CAPTCHA_BUTTON_ID = 'zcode-aliyun-captcha-button';
/**
 * captcha 页面必须导航到的**真实 origin**。
 *
 * ⚠⚠ **这是能否重复 mint 的关键**（实测矩阵）：
 *
 * | origin | 同一页面连续 mint |
 * |---|---|
 * | `about:blank` | **1/3**（#2 起 `F001`） |
 * | **`https://zcode.z.ai/`** | **5/5，平均 546ms** |
 *
 * 阿里云 SDK 会读 `location.origin` 参与风控判定，而 `about:blank` 的
 * origin 是字符串 `"null"` —— 于是第二次起被拒。
 *
 * ⚠ 这一条此前被**误判**成「同一页面不能重复 mint，必须每次新建 page」，
 * 导致实现多付了 2.3 倍的耗时（1246ms → 546ms）。
 * 结论修正的代价是：**改一个变量、看结果**比堆假设更快。
 */
export const CAPTCHA_PAGE_ORIGIN = 'https://zcode.z.ai/';
/**
 * 解析**载体页 origin**：注入值优先，空白/缺省一律回落实测常量。
 *
 * ## 为什么存在（以及它为什么**不是**配置项）
 * 唯一的用途是让本地探针 `scripts/probe-captcha-local-origin.mjs`（不入库）能验证
 * 「在 `http://127.0.0.1:<port>` 这种本地 origin 上，阿里云 SDK 到底产不产得出合法
 * param」—— 那是「DSH web 版能否用用户浏览器当载体」这条路线的唯一准入问题
 * （跨域 iframe 拿不到 DOM、浏览器也不给页面 CDP 权，所以载体页只能是 GUI 自己的 origin）。
 *
 * ⚠ **不许**把它接到 env / settings / UI：真实 https origin 是实测硬前提
 * （`about:blank` 的 origin 是 `"null"`，第二次 mint 必 `F001`）。
 * 默认值与空白回退由 `tests/unit/zcode-captcha-origin.spec.ts` 锁死。
 *
 * ⚠ 空白也算回落：注入空串会让导航变成 `about:blank`（即上面那条已知失败形态）。
 */
export function resolveCaptchaPageOrigin(options = {}) {
    const injected = options.pageOrigin?.trim() ?? '';
    return injected.length > 0 ? injected : CAPTCHA_PAGE_ORIGIN;
}
/**
 * captcha param 的合法判据（与桥侧 `isUsableCaptchaParam` 同一套）。
 *
 * 三条全中才算合法：
 * 1. 长度 ≥ **200**（实测合法值 280；降级垃圾约 76）
 * 2. 是 base64 且能解出 JSON
 * 3. 含 `securityToken` 且长度 ≥ **50**（实测合法值 128）
 *
 * 任一条不中即判为降级 —— **不发请求**：在索要验证的窗口里那发注定 `3007`；
 * 即便上游此刻不校验这个头，把降级产物发出去也不是「成功」，故本地判据不放宽。
 */
export function validateCaptchaParam(param) {
    if (typeof param !== 'string' || param.length === 0) {
        return { ok: false, reason: 'captcha param 缺失' };
    }
    if (param.length < 200) {
        return {
            ok: false,
            reason: `captcha param 长度 ${param.length} < 200（疑似 SDK 降级输出，发了必 3007）`,
        };
    }
    let decoded;
    try {
        decoded = Buffer.from(param, 'base64').toString('utf8');
    }
    catch {
        return { ok: false, reason: 'captcha param 不是合法 base64' };
    }
    let parsed;
    try {
        parsed = JSON.parse(decoded);
    }
    catch {
        return { ok: false, reason: 'captcha param 解出的不是 JSON' };
    }
    if (typeof parsed.certifyId !== 'string' || parsed.certifyId.length === 0) {
        return { ok: false, reason: 'captcha param 缺 certifyId' };
    }
    const token = parsed.securityToken;
    if (typeof token !== 'string' || token.length < 50) {
        return {
            ok: false,
            reason: `securityToken 缺失或过短（${typeof token === 'string' ? token.length : 0} < 50）`,
        };
    }
    return { ok: true };
}
/**
 * 反检测补丁。
 *
 * ⚠ 必须用 `Page.addScriptToEvaluateOnNewDocument` 装 —— 那样它在
 * **每个新文档**上都先于页面脚本执行。只 evaluate 一次不行：
 * 每次 mint 都是新页面（见文件头说明）。
 */
const STEALTH_PATCH = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
Object.defineProperty(navigator, 'plugins', {
  get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }, { name: 'Chromium PDF Viewer' }],
});
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
window.chrome = window.chrome ?? { runtime: {}, loadTimes: () => {}, csi: () => {} };
try {
  const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return originalGetParameter.call(this, parameter);
  };
} catch (error) { /* 内核无 WebGL 时忽略 */ }
`;
/**
 * 构造请求体里那段「建 DOM + 注入 SDK」的表达式。
 *
 * ## ⚠⚠ 这里的 DOM 重置与下面的 SDK 注入**必须配对**（真实缺陷，2026-10-01）
 *
 * 本函数把 `document.body.innerHTML` **整体替换** —— 于是旧的
 * `#captcha-element` / `#captcha-button` 元素**被销毁**。
 *
 * 而 `buildSdkInjectExpression()` 原本在「SDK 已加载」时**早退**（返回
 * `'already'`），**不重建 SDK 实例**。两者叠加的后果：
 *
 * ```
 * 第 1 次 mint：注入 SDK → initAliyunCaptcha 绑定 #captcha-element → ✓ 成功
 * 第 2 次 mint：DOM 被替换（旧元素销毁）→ SDK 早退（实例仍指向旧元素）
 *              → 用失配的实例发起验证 → ✗ F001
 * ```
 *
 * **实测取证**（同一页面、跨轮、每次先空闲 20 秒）：
 *
 * | 场景 | `inject` 返回 | 结果 |
 * |---|---|---|
 * | 页面未重新导航（SDK 已加载 ⇒ 早退） | `already` | ✗ **F001** ×3（471/454/591ms） |
 * | 每轮重新导航（SDK 全新加载） | `function` | ✓ 成功 ×2（755/670ms） |
 *
 * ⇒ **`F001` 与"空闲时长"无关** —— 真正的变量是「DOM 是否被重置而 SDK 未重建」。
 * 这一条纠正了 2026-09-29 的误判（当时把现象归给空闲，并据此加了
 * 「空闲 8 秒就换页」的预测式重建，白付约 2.7 秒/次）。
 *
 * ⚠ 与之配套的修法在 {@link buildSdkInitExpression}：**DOM 重建后必须
 * 重新 `initAliyunCaptcha`**（销毁旧实例、用新元素重新初始化）。
 */
export function buildDomExpression() {
    return `document.body.innerHTML =
    '<div id="${CAPTCHA_CONTAINER_ID}" aria-hidden="true">' +
    '<div id="${CAPTCHA_ELEMENT_ID}"></div>' +
    '<button id="${CAPTCHA_BUTTON_ID}">verify</button></div>'; 'ok'`;
}
/**
 * 构造注入 SDK 的表达式（用 `<script src>`，简单可靠）。
 *
 * ⚠ **无参**：SDK 地址是常量，`region`/`prefix`/`SceneId` 由 {@link buildMintExpression}
 * 在 `initAliyunCaptcha` 那一刻才用 —— 别在这里塞 config，那会多出一条无人读的形参。
 */
export function buildSdkInjectExpression() {
    return `new Promise((resolve) => {
    if (typeof window.initAliyunCaptcha === 'function') { resolve('already'); return; }
    const script = document.createElement('script');
    script.src = ${JSON.stringify(ALIYUN_CAPTCHA_SDK_URL)};
    script.async = true;
    script.onload = () => resolve(typeof window.initAliyunCaptcha);
    script.onerror = () => resolve('onerror');
    document.head.appendChild(script);
    setTimeout(() => resolve('timeout'), 25000);
  })`;
}
/**
 * 构造「触发无感验证并等 param」的表达式。
 *
 * ## 为什么这三个表达式构造函数现在**导出**（二期 Task 3）
 * 内部载体的**载体页**（`src/zcode-carrier-page.ts`）必须由 server 渲染，
 * 才守得住「captcha 表达式只在 server 侧一份」这条约束 ——
 * client 里再写一遍 SDK 调用必然与本文件漂移（本仓库反复吃过同型缺陷）。
 * 除载体页外**不得**有第二个消费方。
 *
 * ⚠ 与 {@link STEALTH_PATCH} 的区别刻意为之：那份反检测补丁是**外挂 chromium**
 * 为了遮 `--headless` 痕迹才需要的，内部载体是 Electron 真实 guest，
 * 实测 `webdriver=false`、UA 带 `Electron/44.0.0` 时 4/4 产出合法 param
 * ⇒ 补丁**既不导出也不使用**（搬进载体页属于无据扩面）。
 */
export function buildMintExpression(config) {
    return `new Promise((resolve) => {
    const done = (payload) => resolve(JSON.stringify(payload));
    /**
     * ★ **降级检测**（2026-10-01，对齐官方 \`mnn\` 的 interactive_displayed）。
     *
     * 我们调的是无感验证（\`startTracelessVerification\`）。阿里云若把本设备
     * 判为风险用户，会**静默弹出交互式验证**（滑块/拼图）—— 而官方文档明确说
     * 「该安全策略逻辑不支持自定义，不对外透出」（验证码 2.0 功能相关问题 Q9）。
     * 也就是说**没有回调告诉我们被降级了**，只能自己看 DOM。
     *
     * ⇒ 轮询检测那些交互元素是否出现过，用一个标志记住「曾经出现过」。
     *
     * ⚠ 用「曾经出现」而不是「此刻存在」：交互元素在验证完成后会被 SDK 移除，
     * 只在 success 那一刻查 DOM 会**漏报**（那正是最需要知道的场景）。
     *
     * ⚠ 选择器取自 dsh-free-glm 对空开源版 renderer 的实测记录
     *（\`bench/CAPTCHA-SLIDER-ATTEMPT.md\` 的 2.1 节，四个 id 逐字一致）。
     */
    let sawInteractive = false;
    const detectInteractive = () => {
      try {
        if (sawInteractive) return;
        if (document.querySelector('#aliyunCaptcha-window-popup')
          || document.querySelector('#aliyunCaptcha-sliding-slider')
          || document.querySelector('#aliyunCaptcha-puzzle')) {
          sawInteractive = true;
        }
      } catch (error) { /* 检测失败不影响产出 */ }
    };
    const pollTimer = setInterval(detectInteractive, 200);
    try {
      window.AliyunCaptchaConfig = ${JSON.stringify({ region: config.region, prefix: config.prefix })};
    } catch (error) { done({ stage: 'cfg-throw', err: String(error) }); }
    try {
      initAliyunCaptcha({
        SceneId: ${JSON.stringify(config.sceneId)},
        mode: 'popup',
        element: '#${CAPTCHA_ELEMENT_ID}',
        // ⚠ 必须传**元素对象**：传字符串会报「button参数传入值不合法」。
        button: document.getElementById('${CAPTCHA_BUTTON_ID}'),
        getInstance: (instance) => {
          try {
            if (typeof instance.startTracelessVerification === 'function') {
              instance.startTracelessVerification();
            } else if (typeof instance.show === 'function') {
              /**
               * ⚠ 走 \`show()\` 说明 SDK 里**没有**无感验证能力 —— 那本身
               * 就是一种降级形态（我们请求的是无感，拿到的是强制交互）。
               */
              sawInteractive = true;
              instance.show();
            }
          } catch (error) {
            done({ stage: 'call-throw', err: String((error && error.message) || error) });
          }
        },
        success: (param) => {
          /**
           * ⚠ 收尾前再查一次 DOM（轮询间隔 200ms，可能在两次轮询之间就完成了）。
           */
          detectInteractive();
          clearInterval(pollTimer);
          done({ stage: 'success', param, interactive: sawInteractive });
        },
        fail: (error) => {
          clearInterval(pollTimer);
          done({
            stage: 'fail',
            err: String((error && error.message) || JSON.stringify(error)),
            interactive: sawInteractive,
          });
        },
        onError: (error) => {
          clearInterval(pollTimer);
          done({
            stage: 'onError',
            err: String((error && error.message) || JSON.stringify(error)),
            interactive: sawInteractive,
          });
        },
      });
    } catch (error) {
      clearInterval(pollTimer);
      done({ stage: 'init-throw', err: String((error && error.message) || error) });
    }
    setTimeout(() => {
      clearInterval(pollTimer);
      done({ stage: 'timeout', interactive: sawInteractive });
    }, 60000);
  })`;
}
/**
 * 常驻浏览器会话。
 *
 * ## 为什么常驻
 *
 * 冷启动实测约 690ms，但**每次请求都冷启动**会让首字延迟凭空多一秒。
 * 而 mint 只在**上游索要验证时**才发生：复用常驻页面的稳态约 0.4–0.5 秒
 * （中位 426ms / 平均 546ms，见 `CAPTCHA_PAGE_ORIGIN` 的矩阵），含 chromium
 * 冷启动的首发实测 4.2 秒；至于「每次新建 page」那个 1246ms，是 origin 修正
 * **之前**的历史值，别当现行口径（数字汇总见 README 的 ZCode 章节）。
 * （上游不要验证的窗口里这条路**一次都不走**，见文件头的「按需」段。）
 *
 * ## 生命周期
 *
 * `dispose()` 必须被调用（`ZcodeAuth.stop()` 里做），否则会留下
 * 一个孤儿 chromium 进程（约 200-400MB）。此外还注册了进程退出钩子兜底。
 */
export class ZcodeCaptchaBrowser {
    options;
    /**
     * 共享的 chromium 会话（**进程 + 调试端口 + 浏览器级 CDP 通道**）。
     *
     * ⚠ 本类**不再自己**管进程、端口与「连不上旧实例」那条隐蔽链 —— 那些
     * 全部搬到了 {@link ChromiumSession}，由它与库库AI 的登录浏览器**共用同一份
     * 实现**（一份语义一处实现）。本类只保留 **captcha 专有**的状态：复用页池
     * 与占用闸门。
     */
    session;
    /**
     * 复用的 captcha 页面（停在 {@link CAPTCHA_PAGE_ORIGIN} 上）。
     *
     * ⚠ 复用而非每次新建：实测 546ms vs 1246ms（快 2.3 倍）。
     * 前提是 origin 必须真实 —— 见 `mint()` 的说明。
     */
    reusablePage;
    /**
     * 页面是否正被某次 mint 占用。
     *
     * captcha param 是**一次性**的，两个并发 mint 共用同一页面会互相踩状态。
     * 故用该标志把取页串行化（并发调用排队，而不是拿到同一个页面）。
     */
    pageBusy = false;
    /** 诊断输出（见 {@link ZcodeCaptchaBrowserOptions.log}），缺省 undefined = 静默。 */
    log;
    constructor(options = {}) {
        this.options = options;
        this.log = options.log;
        /**
         * ⚠⚠ 下面这些取值**必须与重构前逐字一致**。它们的产物是**渲染后的报错
         * 原文**，而 spawn 护栏用例跑的是编译产物里的**真实子进程**、断言的就是
         * 那些字 —— 少一个括注、把产品名从两词写成一词，都会变红。
         *
         * 逐项对应（左 = 重构前写死在 `launch()` 里的字面量，右 = 现在传的参）：
         * - 错误消息前缀 → `label`
         * - 「找不到浏览器」文案里紧跟其后的括注 → `notFoundHint`
         * - Edge 兜底告警里的产品名（与错误前缀**不同**）→ `edgeLabel`
         * - 提示用户改用的环境变量名 → `overrideEnvName`
         * - 临时 profile 目录前缀 → `profilePrefix`
         * - 窗口尺寸 → `windowSize`
         */
        this.session = new ChromiumSession({
            executablePath: options.executablePath,
            debugPort: options.debugPort,
            hideWindow: options.hideWindow,
            profilePrefix: 'zcode-captcha-',
            readyTimeoutMs: options.readyTimeoutMs,
            windowSize: '1280,900',
            label: 'zcode',
            notFoundHint: '（用于产出阿里云 captcha）',
            edgeLabel: 'zcode captcha',
            overrideEnvName: 'ZCODE_CHROME_PATH',
            log: this.log,
        });
    }
    /**
     * 浏览器级 CDP 通道。
     *
     * ⚠ 必须**可读又可写**（不是只读 getter）：既有回归用例直接往这个字段
     * 注入桩（`tests/unit/zcode-page-prepared.spec.ts` 的 `makeBrowserWithStub`）。
     * 这里转发到会话上，避免「同一个通道在两层各存一份」。
     */
    get browserCdp() {
        return this.session.cdp;
    }
    set browserCdp(value) {
        this.session.cdp = value;
    }
    /**
     * 浏览器级 WebSocket（同样转发）。
     *
     * ⚠ 用例注入的是 `{ readyState: 1 }` 这种**形状兼容的桩**，
     * 故这里只按 `readyState` 用，不调用真实 WebSocket 的方法。
     */
    get browserWs() {
        return this.session.socket;
    }
    set browserWs(value) {
        this.session.socket = value;
    }
    /** 调试端口（`/json/list` 与 `/json/close` 用）。 */
    get port() {
        return this.session.debugPort;
    }
    /** 浏览器是否已就绪。 */
    get ready() {
        return this.session.ready;
    }
    /**
     * 启动（幂等；并发调用共享同一次启动）。
     *
     * ⚠ 失败时**必须连页池一起清掉**（保持重构前的行为）：起不来的那一轮里，
     * 上一次成功会话遗留的页面已经指向一个**不存在的浏览器**，留着会让
     * 后续 `acquirePage()` 直接交出死页面。
     */
    async start() {
        try {
            await this.session.start();
        }
        catch (error) {
            this.resetPages();
            throw error;
        }
    }
    /** 关掉复用页、放开占用闸门（**不碰**浏览器进程）。 */
    resetPages() {
        try {
            this.reusablePage?.cdp.close();
        }
        catch { /* 已关闭 */ }
        try {
            this.reusablePage?.ws.close();
        }
        catch { /* 已关闭 */ }
        this.reusablePage = undefined;
        this.pageBusy = false;
    }
    /**
     * 产出**一个新鲜**的 captcha param。
     *
     * ## ⚠⚠ 实测约束（第 2 条曾在 2026-10-01 被**推翻并修正**，务必读完）
     *
     * ### 1. 页面 origin 必须是**真实 https**，不能用 `about:blank`
     *
     * | origin | 同页连续 mint |
     * |---|---|
     * | `about:blank` | **1/3**（#2 起 `F001`） |
     * | `https://zcode.z.ai/` | 连续 5/5 |
     *
     * 阿里云 SDK 会检查 origin（`about:blank` 的是 `"null"`），风控据此拒绝。
     *
     * ### 2. ~~空闲约 15 秒后同一页面必然失效~~ → **已推翻**
     *
     * 曾经（2026-09-29）观测到下面这张表，据此加了「空闲 8 秒就换页」：
     *
     * | 用例 | 当时的结果 |
     * |---|---|
     * | 立即 mint | ✓ 3786ms |
     * | **间隔 15s**（复用页面） | ✗ `F001` 416ms |
     * | 间隔 45s / 90s（复用页面） | ✗ `F001` |
     * | 全新浏览器 + 新页面 | ✓ 3692ms |
     *
     * ⚠ 但 2026-10-01 用**变量分离**复测（同一页面、零换页、每组都先预热成功）
     * **无法复现**：
     *
     * | 场景 | 结果 | 耗时 |
     * |---|---|---|
     * | 空闲 20 秒后**什么都不做**直接 mint | ✓ **3/3** | **467ms** |
     * | 空闲 20 秒后**重置 DOM** 再 mint（= 当时的生产行为） | ✓ 3/3 | 479ms |
     * | 空闲 20 秒后清 SDK 全局 + 重注入 | ✓ 2/2 | 488ms |
     *
     * ⇒ **`F001` 与"空闲时长"没有稳定因果关系**（当时那次更可能是环境/风控
     * 的瞬时状态，或与实验方法有关 —— 我早期两个实验分别在 baseline 前
     * 跑了注入、以及误用了私有 `acquirePage`，两者都污染过结论）。
     *
     * ### 3. 因此现在的策略：**复用优先，失败才换页**
     *
     * ```
     * 默认（idleReuseMs = Infinity）  → 只要页面还在就复用（约 0.5 秒）
     * 任一次 mint 失败（F001 等）      → 丢弃该页、换新页重试一次（自愈链）
     * ```
     *
     * ⚠ 原来的「预测式换页」让**每次空闲后都白付约 2.7 秒**建页成本 ——
     * 这正是用户报障「一键签到里 ZCode 很久」的成因（而不是 captcha 慢）。
     * 改成失败兜底后：**常态省约 2.7 秒、不增加 captcha 调用次数**，
     * 真遇到 `F001` 时的自愈能力与原来一致（甚至更快：
     * 原来"先换页"是必然付费，现在只在真失败时才付）。
     */
    /**
     * 产出 captcha param，**并报告本次是否被降级为交互式验证**。
     *
     * ## 为什么需要（对齐官方 ZCode 的观测，2026-10-01）
     *
     * 官方闭源版对每次产出结果都会区分并上报（`out/renderer/assets/styles-*.js`）：
     *
     * ```js
     * mnn({ result: e ? 'interactive_displayed' : 'traceless_passed', … })
     * // pnn() 里维护 traceless_passed_count / captcha_displayed_count
     * ```
     *
     * 那是它判断**设备信誉是否在恶化**的手段 —— 而此前我们没有任何这个数，
     * 排查「为什么突然 502 mint failed」时只能靠猜（这正是本次最缺的东西）。
     *
     * ⚠ 与 {@link mint} 的关系：那个是「只要 param」的既有签名（多处调用），
     * 这个是它的**超集**，内部复用同一条产出路径 —— 不要各写一份。
     */
    async mintWithOutcome(config = ZCODE_CAPTCHA_FALLBACK, options = {}) {
        return await this.mintInternal(config, options);
    }
    /**
     * 产出 captcha param。
     *
     * ## 复用策略（⚠ 空闲失效，见本方法上方的实测表）
     *
     * ```
     * 默认（idleReuseMs = Infinity）→ 复用（约 0.5 秒）
     * 任一次 mint 失败（F001 等）    → 丢弃页面、换新重试一次
     * ```
     *
     * ⚠ **不再按空闲时长预测式换页**（2026-10-01 修正）：原「空闲 15 秒必然
     * 失效」的推论在变量分离复测中**无法复现**，详见 `mintInternal` 上方的
     * 完整对照表。预测式换页让每次空闲后白付约 2.7 秒。
     */
    async mint(config = ZCODE_CAPTCHA_FALLBACK, options = {}) {
        return (await this.mintInternal(config, options)).param;
    }
    /** `mint` / `mintWithOutcome` 的共用实现（**唯一**的产出路径）。 */
    async mintInternal(config, options) {
        await this.start();
        /**
         * ⚠ 最多两次：第一次用（可能复用的）页面，失败则**丢掉它换新**再试。
         *
         * 第二次仍失败才上抛 —— 那种情况通常是服务端限频/风控，
         * 换页面也救不了（实测过：全新浏览器也失败）。
         */
        const attempts = 2;
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            /**
             * ⚠ 每轮先看中断：用户点了「停止」就不该再开新一轮
             * （否则会出现「停了还在后台 mint」的错觉）。
             */
            if (options.signal?.aborted === true) {
                throw lastError ?? new Error('zcode: captcha 产出已取消');
            }
            const forceFresh = attempt > 1;
            const page = await this.acquirePage(forceFresh, options.signal);
            try {
                const outcome = await this.mintOnPage(page, config);
                page.lastUsedAt = Date.now();
                return outcome;
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                /**
                 * ⚠ **失败的页面必须作废**：它已进入坏的 captcha 会话状态，
                 * 留在池里会让下一次也失败（实测：失败页面上再 mint 依然 `F001`）。
                 */
                this.discardPage(page);
                if (attempt < attempts) {
                    // 换新页面前稍微让一下，避免与刚作废的会话竞争。
                    await sleep(300);
                }
            }
            finally {
                /**
                 * ⚠⚠ **必须无条件复位 `pageBusy`**（真实缺陷，2026-09-29）。
                 *
                 * 旧写法是 `if (this.reusablePage === page) this.releasePage(page)` ——
                 * 而 catch 里已经 `discardPage(page)`（它把 `reusablePage` 置空），
                 * 于是这个条件**恒为假**，`pageBusy` 永远停在 `true`。
                 * 下一次 `acquirePage()` 就卡在 `while (this.pageBusy) await sleep(50)`
                 * 里永久自旋 ⇒ 适配器的 `await this.mintCaptcha()` 永不返回，
                 * 请求根本不发出，UI 永远「深度求索中」。
                 *
                 * 故这里补上 else 分支：`pageBusy = false` 原本只出现在
                 * `releasePage` / `kill` 里，而那两条都不是本路径的必然出口。
                 */
                if (this.reusablePage === page)
                    this.releasePage(page);
                else
                    this.pageBusy = false;
            }
        }
        throw lastError ?? new Error('zcode: captcha 产出失败（未知原因）');
    }
    /** 在**指定页面**上跑一次 captcha（不含页面获取/重试逻辑）。 */
    async mintOnPage(page, config) {
        /**
         * ★★ **复用已就绪的页面时，跳过 DOM 重置与 SDK 注入**（2026-10-01 修正）。
         *
         * ## 为什么（真实缺陷，且此前被误判为「空闲失效」）
         *
         * 旧实现**每次**都做：
         *
         * ```js
         * ① document.body.innerHTML = '<div id="captcha-container">…'  // 销毁旧元素
         * ② buildSdkInjectExpression()   // SDK 已加载 ⇒ 返回 'already'（**不重建实例**）
         * ③ initAliyunCaptcha({element:'#captcha-element', button:<新元素>})
         * ```
         *
         * ⚠ ①②③ 互相踩：SDK 的实例仍绑定 ① **已销毁**的旧元素，
         * 于是发起验证时服务端回 `F001`。
         *
         * **实测取证**（同一页面、跨轮、每轮先空闲 20 秒）：
         *
         * | 场景 | `inject` 返回 | 结果 |
         * |---|---|---|
         * | 页面未重新导航（SDK 已加载 ⇒ 早退） | `already` | ✗ **F001 ×3**（471/454/591ms） |
         * | 每轮重新导航（SDK 全新加载） | `function` | ✓ 成功 ×2（755/670ms） |
         *
         * ⇒ **`F001` 与"空闲时长"无关**，真正的变量是「DOM 被重置而 SDK 未重建」。
         * 这纠正了 2026-09-29 的误判 —— 当时据此加了「空闲 8 秒就换页」的
         * 预测式重建，让**每次空闲后白付约 2.7 秒**（用户报障「签到很久」的成因）。
         *
         * ## 修法
         *
         * ```
         * 页面是**新建的**（首次使用） → 完整准备：重置 DOM + 注入 SDK
         * 页面是**复用且已就绪**的         → **跳过**，直接用（元素与实例都还匹配）
         * ```
         *
         * ⚠ 为什么跳过是安全的：`mint` 成功**不会移除** `#captcha-element` /
         * `#captcha-button`（实测：空闲前后 `el=true btn=true sdk=function`）。
         * 既然元素与实例都还在，重置 DOM 反而是**破坏**它们。
         *
         * ⚠ 若页面状态不明（`prepared` 未标记），仍走完整准备 —— 保守优先。
         */
        if (page.prepared !== true) {
            await page.cdp.send('Runtime.evaluate', { expression: buildDomExpression(), returnByValue: true });
            const injected = await page.cdp.send('Runtime.evaluate', {
                expression: buildSdkInjectExpression(),
                awaitPromise: true,
                returnByValue: true,
            });
            const injectedType = injected?.result?.value;
            if (injectedType !== 'function' && injectedType !== 'already') {
                throw new Error(`zcode: 阿里云 captcha SDK 未加载（${String(injectedType)}）`);
            }
            page.prepared = true;
        }
        const minted = await page.cdp.send('Runtime.evaluate', {
            expression: buildMintExpression(config),
            awaitPromise: true,
            returnByValue: true,
        }, 75_000);
        const raw = minted?.result?.value;
        let parsed;
        try {
            parsed = JSON.parse(String(raw));
        }
        catch {
            throw new Error(`zcode: captcha 结果无法解析（${String(raw).slice(0, 160)}）`);
        }
        if (parsed.stage !== 'success' || typeof parsed.param !== 'string') {
            throw new Error(`zcode: captcha 产出失败（stage=${parsed.stage ?? '?'}` +
                `${parsed.err !== undefined ? `, err=${parsed.err}` : ''}）`);
        }
        const verdict = validateCaptchaParam(parsed.param);
        if (!verdict.ok) {
            throw new Error(`zcode: captcha param 不可用（${verdict.reason ?? '未知'}）`);
        }
        /**
         * ⚠ `interactive` 缺失时取 `false`（保守）：我们**只在明确观察到弹窗时**
         * 才认定被降级。宁可不报（少一次误导性告警），也不要把正常无感通过
         * 错报成降级 —— 那会让用户以为信誉出了问题而去做无谓处置。
         */
        return { param: parsed.param, interactive: parsed.interactive === true };
    }
    /**
     * 取一个可用的页面。
     *
     * ## 复用策略：**复用优先，失败才换页**
     *
     * ```
     * forceFresh = true            → 丢弃旧页、建新页（`mint()` 第一次失败后的重试）
     * 空闲 > idleReuseMs           → 丢弃旧页、建新页（默认 Infinity ⇒ 不触发）
     * 否则                          → 复用（约 0.5 秒）
     * ```
     *
     * ⚠ **默认不再按空闲时长换页**（2026-10-01 修正）：原「空闲 15 秒必然
     * `F001`」的推论在变量分离复测中**无法复现**（空闲 20 秒后直接复用
     * 仍 3/3 成功、约 0.47 秒），而每次换页要付约 2.7 秒。
     * 详见 `ZcodeCaptchaBrowserOptions.idleReuseMs` 的完整说明。
     *
     * ⚠ 串行化：captcha 是**一次性**的，两个并发 mint 共用同一页面会互相
     * 踩状态。故用 `busy` 标志把取页串起来 —— 并发调用会排队，
     * 而不是拿到同一个页面。
     */
    async acquirePage(forceFresh = false, signal) {
        /**
         * ⚠ 等待必须**有界且可取消**（真实缺陷，2026-09-29）。
         *
         * 旧实现是裸的 `while (this.pageBusy) await sleep(50)`：一旦某个持有者
         * 没能复位标志（见 `mint()` 的 finally），这里就是**永久自旋** ——
         * 而它既不看 signal 也没有上限，于是表现为「请求根本不发出 +
         * 用户点停止也无反应」，只能重启宿主。
         *
         * ⚠ 超时**不**复位 `pageBusy`：此刻它属于**另一个**持有者，
         * 越权复位会让两个 mint 同时用同一页面（captcha 是一次性的，必串状态）。
         */
        const waitTimeoutMs = this.options.pageWaitTimeoutMs ?? 30_000;
        const deadline = Date.now() + waitTimeoutMs;
        while (this.pageBusy) {
            if (signal?.aborted === true)
                throw new Error('zcode: captcha 取页等待已取消');
            if (Date.now() >= deadline) {
                throw new Error(`zcode: captcha 页面被占用超过 ${waitTimeoutMs}ms（疑似上一次 mint 未归还）`);
            }
            await sleep(50);
        }
        this.pageBusy = true;
        /**
         * ★ **复用优先，失败才换页**（默认 `Infinity` = 不因空闲换页）。
         *
         * 见 `ZcodeCaptchaBrowserOptions.idleReuseMs` 的完整说明：
         * 原默认 8 秒基于「空闲 15 秒必然 F001」这条推论，而它在 2026-10-01 的
         * 严格复测中**无法复现** —— 空闲 20 秒后直接复用仍 3/3 成功（约 0.47 秒），
         * 而每次换页要付约 2.7 秒。用户报障的「签到很久」正源于此。
         *
         * 失败时 `mint()` 的 `attempt > 1` 会传 `forceFresh = true` 换页重试，
         * 故**自愈能力不变**。
         */
        const idleReuseMs = this.options.idleReuseMs ?? Number.POSITIVE_INFINITY;
        const existing = this.reusablePage;
        if (existing !== undefined) {
            const idle = Date.now() - existing.lastUsedAt;
            if (!forceFresh && idle <= idleReuseMs)
                return existing;
            /**
             * ⚠ 该换新了 —— **必须先丢弃**（关闭它），否则页面会累积，
             * 且旧的坏会话可能仍有副作用。
             */
            this.discardPage(existing);
        }
        const browser = this.browserCdp;
        if (browser === undefined) {
            this.pageBusy = false;
            throw new Error('zcode: 浏览器未就绪');
        }
        /**
         * ⚠ `createTarget` 必须包在 try 里（真实缺陷，2026-09-29）：它走 CDP，
         * 超时（30s）或浏览器僵死时会**抛错**，而旧代码把它放在 try 之外 ——
         * 抛出后 `pageBusy` 不复位 ⇒ 后续**每一次** mint 都在自旋里死等。
         */
        let targetId;
        try {
            const created = await browser.send('Target.createTarget', { url: 'about:blank' });
            targetId = typeof created.targetId === 'string' ? created.targetId : undefined;
        }
        catch (error) {
            this.pageBusy = false;
            throw error;
        }
        if (targetId === undefined) {
            this.pageBusy = false;
            throw new Error('zcode: 无法新建页面 target');
        }
        let ws;
        try {
            const targets = await (await fetch(`http://127.0.0.1:${this.port}/json/list`, {
                signal: AbortSignal.timeout(5_000),
            })).json();
            const target = targets.find((item) => item.id === targetId);
            if (typeof target?.webSocketDebuggerUrl !== 'string') {
                throw new Error('zcode: 新页面没有可用的调试地址');
            }
            ws = new WebSocket(target.webSocketDebuggerUrl);
            const connectTimeoutMs = this.options.connectTimeoutMs ?? 10_000;
            await new Promise((resolve, reject) => {
                /**
                 * ⚠ **必须有超时**（真实缺陷，2026-09-29）：旧实现只等 `open` / `error`，
                 * 而 Chromium 僵死时**两个事件都不会来** —— 永久挂起；更糟的是
                 * 它不抛错，`pageBusy` 也就不会复位（下一轮直接死锁）。
                 *
                 * ⚠ signal 也要接进来：用户点「停止」时不该继续等建连。
                 */
                let settled = false;
                let timer;
                const cleanup = () => {
                    if (timer !== undefined)
                        clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                };
                const done = (settle) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    settle();
                };
                const onAbort = () => done(() => reject(new Error('zcode: 连接新页面已取消')));
                timer = setTimeout(() => done(() => reject(new Error(`zcode: 连接新页面超时（${connectTimeoutMs}ms）`))), connectTimeoutMs);
                timer.unref?.();
                ws?.addEventListener('open', () => done(resolve), { once: true });
                ws?.addEventListener('error', () => done(() => reject(new Error('zcode: 连接新页面失败'))), { once: true });
                signal?.addEventListener('abort', onAbort, { once: true });
            });
            const cdp = new CdpConnection(ws);
            await cdp.send('Page.enable');
            await cdp.send('Runtime.enable');
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_PATCH });
            /**
             * ⚠ **导航到真实 https origin**（不是 `about:blank`）——
             * 这是能否重复 mint 的关键（实测 1/3 → 5/5）。
             */
            await cdp.send('Page.navigate', { url: resolveCaptchaPageOrigin(this.options) });
            // 等 DOM 可用（domcontentloaded 之后 body 就存在了）。
            await sleep(this.options.navigationWaitMs ?? 1_500);
            const page = { targetId, ws, cdp, lastUsedAt: Date.now() };
            this.reusablePage = page;
            return page;
        }
        catch (error) {
            try {
                ws?.close();
            }
            catch { /* 已关闭 */ }
            this.pageBusy = false;
            try {
                await fetch(`http://127.0.0.1:${this.port}/json/close/${targetId}`, {
                    signal: AbortSignal.timeout(3_000),
                });
            }
            catch { /* ignore */ }
            throw error;
        }
    }
    /**
     * 作废一个页面：关掉它、从池里摘掉。
     *
     * ⚠ **必须真的关闭 target**（不只是清引用）—— 否则页面会累积，
     * 且每个坏页面都占着一份 SDK 实例。
     *
     * ⚠ 关不掉也不抛错：这是清理路径，不该因为清理失败而让 mint 报错。
     */
    discardPage(page) {
        if (this.reusablePage === page)
            this.reusablePage = undefined;
        try {
            page.cdp.close();
        }
        catch { /* 已关闭 */ }
        try {
            page.ws.close();
        }
        catch { /* 已关闭 */ }
        void (async () => {
            try {
                await fetch(`http://127.0.0.1:${this.port}/json/close/${page.targetId}`, {
                    signal: AbortSignal.timeout(3_000),
                });
            }
            catch { /* 关不掉也无妨 */ }
        })();
    }
    /** 归还页面（保留复用）。 */
    releasePage(page) {
        void page;
        this.pageBusy = false;
    }
    /**
     * 关闭浏览器并清理临时 profile。
     *
     * ⚠ **不再有**「只杀进程、保留 profile」的那条路：它原本只服务于
     * `launch()` 内部的失败清理（起不来 / 端口没就绪 / 端口误配时重来一次），
     * 而那些路径已随启动流程一起搬进 {@link ChromiumSession}，由它自己
     * 按需调用自己的 `kill()`。留一个**没有调用方**的私有方法只会制造
     * 「进程树有两个所有者」的错觉 —— 进程生命周期**只有一处**实现。
     *
     * ⚠ 进程树清理的全部取证（为什么必须整棵树、为什么必须同步
     * `taskkill /T /F`、端口误配那条隐蔽链）见 `ChromiumSession`。
     */
    dispose() {
        this.resetPages();
        this.session.dispose();
    }
}
/**
 * 用户主目录（导出给测试注入用；避免测试真的去碰 `~/.zcode`）。
 *
 * 目前仅用于文档目的 —— 实际路径解析在 `zcode.ts` 的候选表里。
 */
export const ZCODE_HOME = homedir();
//# sourceMappingURL=zcode-captcha.js.map