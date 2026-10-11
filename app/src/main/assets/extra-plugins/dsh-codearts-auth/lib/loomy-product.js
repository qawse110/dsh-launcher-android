/**
 * Loomy（讯飞）产品配置。
 *
 * ## 为什么新建 `LoomyProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` 的字段全部围绕各自
 * 协议设计（归属头、refresh 载荷、WASM 签名参数…），对 Loomy 无一有意义。
 * Loomy 需要的是：两个 base URL（账号 vs 业务）、讯飞 AccessKey、
 * 以及一张兜底模型表。故定义**平行**的接口 —— 共用的是架构**模式**
 * （产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * - base URL / AccessKey / appId：`C:\Program Files\Loomy\resources\.env.prod`
 *   Loomy 官方也只是「随客户端分发 + AES 混淆」，本质同样是公开的。
 * - 兜底模型表：2026-09-26 用本机登录态实测 `GET /api/v1/models` 取得
 *   （11 条中 `type==='chat'` 的 8 条）。
 *
 * ## ⚠️ AccessKey 的定位
 *
 * 它只用于**讯飞账号**端点（`account.xfinfr.com`）的 HMAC-SHA1 签名
 * （短信验证码登录）。业务与推理端点用的是用户登录后的 `session`，
 * 与 AccessKey 无关。故 AccessKey 泄露不涉及任何用户数据。
 */
import { LOOMY_ACCOUNT_BASE, LOOMY_API_BASE } from './loomy.js';
/**
 * 兜底模型目录（8 个 chat 模型）。
 *
 * 来源：2026-09-26 实测 `GET /api/v1/models`，取 `type === 'chat'` 的条目。
 * 顺序**照抄远端返回顺序**，不重排 —— 重排会让「与远端对比」这类排查失去可比性。
 *
 * ⚠️ `name` 已按 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 * ⚠️ `contextWindow` **不是**远端 `context_length` 的照抄 —— 见
 * {@link LOOMY_CONTEXT_WINDOW_OVERRIDES}（`spark-x` 远端虚高）。
 */
/**
 * 实测的思考档位（8 个 chat 模型**完全一致**，2026-09-28 用真实凭据采集）。
 *
 * ⚠️ 抽成常量而不是逐条写 8 遍：远端对全部 chat 模型下发同一份档位，
 * 逐条重复只会让将来上游变更时漏改其中几条。
 * ⚠️ 远端可用时**优先用远端的 `reasoning_efforts`**，本常量只在远端整体失败时
 * 顶替（与 `contextWindow` 同策略）。
 */
const LOOMY_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];
/**
 * 本插件选用的默认档位（**用户要求 `high`**）。
 *
 * ⚠️ 远端 `default_reasoning_effort` 声明的是 **`low`**，这里**有意不沿用** ——
 * DSH 的「用户没选时发哪个档」完全取适配器声明的 `defaultEffort`
 * （见 `loomy-adapter.ts` 的 `LOOMY_PREFERRED_DEFAULT_EFFORT` 说明）。
 * 兜底表与适配器常量必须一致，否则「远端可用」与「远端失败」两条路径默认档不同。
 */
const LOOMY_DEFAULT_EFFORT = 'high';
/**
 * 上下文窗口的**逐模型硬覆盖**（`模型 id → 真实窗口`）。
 *
 * ## 为什么需要（真实缺陷，Gitee issue IKJW31）
 *
 * 远端 `GET /models` 对 **`spark-x` 声明 `context_length: 1048576`，而真实墙在
 * 262144**：宿主按 1M 放心打包，输入一旦越过 256K，上游**收下请求但 0 输出**并回
 * `finish_reason=length`，插件映射成 `max-tokens`，而 DSH 对它**不自动重试**
 * ⇒ 长会话表现为「有时候 token 截断 / 已达到输出 token 上限」。
 *
 * ### 硬证据（2026-10-08 复核）
 *
 * 1. **上游墙位**：报障会话 4 次失败的 prompt 总量**逐 token 相同** ——
 *    `261,818 + 320`、`58 + 262,080`（×2）、`252,346 + 9,792`，
 *    全部 = **262,138 = 262,144 − 6**；而同一晚直连（非 auto）的 zcode 473K /
 *    workbuddy 518K / codearts 644K 全部正常 ⇒ 墙**只属于**这一个模型。
 * 2. **官方客户端的本地表**：`C:\Users\Public\Loomy\<hash>\opencode\opencode.json`
 *    实测 `spark-x` 的 `limit.context = 262144`，而同一文件其余 7 个模型的
 *    `limit.context` **与远端逐条一致** ⇒ 官方**只对这一个是刻意降档**的。
 *    这正是旧注释里提到的 `MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }`。
 * 3. **远端自身也在漂移**：`GET /models` 的 chat 条目已从 8 条涨到 **9 条**
 *    （新增 `DeepSeek-V4.1-Flash`）⇒ 「照抄远端」注定过期，与远端**不一致**
 *    必须有显式的、带证据的覆盖点。
 *
 * ⚠️ **旧注释「本表先采信远端；若实测长上下文被拒，改为 262144」已按
 * `262144` 落地** —— 该条件早已满足（见上面第 1 条），别再改回去。
 *
 * ## ⚠️⚠️ 为什么**不能**改成「未验证的条目干脆不声明窗口」
 *
 * 这看起来更保守，实际更危险。本机实测 `dsh-compaction-basic`（DSH 0.2.0-rc.3）：
 *
 * ```
 * if (info.context === void 0)
 *   throw new TargetPressureConfigError(targetKey, `…; configure contextWindow on that adapter model`)
 * ```
 *
 * 而该异常在 `agent/pre-step` 被**吞成一条 warn**（`step compaction failed: …;
 * continuing the turn`，且同一目标只警告一次）⇒ **自动压缩从此永久静默失效**。
 *
 * 两者的可观测性差一个量级：**虚高**至少在越墙时留下「0 输出 + `max-tokens`」的
 * 现场；**不声明**则连压缩都不触发，用户与日志两边都零信息 —— 正是
 * `opencode-context-window.spec.ts`（issue IKJJ68）记录的同款症状。
 * ⇒ 有独立证据的条目写**真实值**，没有证据的**保留远端声明**，绝不改成不声明。
 */
export const LOOMY_CONTEXT_WINDOW_OVERRIDES = {
    // 远端虚报 1048576，官方客户端本地表与上游墙位都是 262144（见上）。
    'spark-x': 262_144,
};
/**
 * 取一个模型的**真实**上下文窗口。
 *
 * 覆盖表优先于远端，原因见 {@link LOOMY_CONTEXT_WINDOW_OVERRIDES}。
 * ⚠️ 远端与兜底表**两条路径都必须过这里** —— 只改兜底表无效（远端可用时
 * 走的是远端值），这是个曾经差点踩空的点。
 *
 * @param modelId 模型 id。
 * @param declared 声明值（远端 `context_length` 或兜底表的值）。
 * @returns 覆盖值（若有），否则原样返回 `declared`。
 */
export function loomyContextWindow(modelId, declared) {
    return LOOMY_CONTEXT_WINDOW_OVERRIDES[modelId] ?? declared;
}
const LOOMY_FALLBACK_MODELS = [
    { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731 · x3.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'MiniMax-M3', name: 'MiniMax M3 · x4.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'Kimi-k2.6', name: 'Kimi k2.6 · x6.5', contextWindow: 262_144, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max · x12.0', contextWindow: 1_000_000, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash · x0.8', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'qwen3.8-flash', name: 'qwen 3.8 flash · x0.8', contextWindow: 1_000_000, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'spark-x', name: 'Spark X2.5 · x0.1', contextWindow: 262_144, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'mimo-v2.5', name: 'MiMo V2.5 · x3.3', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
];
/**
 * Loomy provider 配置。
 */
export const LOOMY = {
    id: 'loomy',
    displayName: 'Loomy (讯飞)',
    apiBase: LOOMY_API_BASE,
    accountBase: LOOMY_ACCOUNT_BASE,
    // 取自 `.env.prod`（VITE_XFYUN_ACCESS_KEY_ID / _SECRET / _APP_ID）。
    accessKeyId: '2thryby66wxi53sk',
    accessKeySecret: 'zsak6eadrbawz683wf5r3m2snrwj868r',
    appId: 'GM3LOOMY',
    defaultCredentialRef: 'LOOMY_ACCESS_TOKEN',
    fallbackModels: LOOMY_FALLBACK_MODELS,
};
/** 全部 Loomy 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_LOOMY_PRODUCTS = [LOOMY];
/**
 * 按 provider id 取 Loomy 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` 等分开：
 * 各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function loomyProductById(id) {
    return ALL_LOOMY_PRODUCTS.find((product) => product.id === id);
}
//# sourceMappingURL=loomy-product.js.map