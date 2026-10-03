/**
 * Qoder 产品配置。
 *
 * ## 为什么不复用 `BuddyProduct` / `LobsteraiProduct`
 *
 * Qoder 的协议与现有四个 provider **都不同源**：
 *
 * | 维度 | codearts | buddy/workbuddy | lobsterai | qoder |
 * |------|----------|-----------------|-----------|-------|
 * | 登录 | OAuth 回调 | external-link 轮询 | 本地回调 + authCode | PKCE 设备码轮询 |
 * | 续期 | refresh_token | refresh_token | refresh_token + 身份字段 | refresh_token + machine_id |
 * | 签名 | HMAC-SHA256 | 无 | 无 | 无（推理） |
 *
 * 且 `BuddyProduct.id` 是字面量联合 `'buddy' | 'workbuddy'`，加值会牵动
 * `productById` / `registerBuddyLlm` 一串调用点。故这里定义**平行**的
 * `QoderProduct` —— 共用的是架构**模式**（产品差异收敛到单一真相源），
 * 不是那个类型。
 *
 * ## 数据来源
 *
 * 全部来自本机 Qoder 0.3.4 产物逆向 + 实测，详见
 * `docs/superpowers/specs/2026-09-19-qoder-provider-design.md` §2。
 * 逆向目标：
 * - `C:\Users\Jet\AppData\Local\Programs\Qoder\resources\app.asar`
 * - `...\@qoder-ai\qoder-agent-sdk\dist\_worker\qoder-worker-runtime.obf.mjs`
 *   （字符串经 `_$d = base64 → XOR("tqrRVttEZQ4G")` 编码）
 */
/**
 * 模型目录（**实测数据**，2026-09-20）。
 *
 * ## `id` 是目录 key，且**必须走加密端点**
 *
 * 这些 key（`qfmodel` / `dmodel` / …）是 Qoder 客户端的**真实模型标识**，
 * 但公开的 `/model/v1/chat/completions` **不认它们**：
 *
 * ```
 * {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\""}
 * ```
 *
 * 客户端真实推理走**加密端点**（见 `src/qoder-wasm.ts`）：
 * ```
 * POST {host}/algo/api/v2/service/pro/sse/agent_chat_generation
 *      ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 * body: <WASM 加密>
 * ```
 * 该端点**认这些 key**（实测 17 个全部可用）。
 *
 * ⚠️ 但请求体**必须带 `business` 字段**（见 `src/qoder-adapter.ts`）：
 * 缺了服务端会把请求路由到故障节点 `oa_qwen-plus-2025-04-28` 并返回
 * `[FAIL]node:... msg:Execution failed`。`qfmodel` 曾因此被误判为
 * 「服务端故障」（而 IDE 里同一模型完全正常）。
 *
 * ## ⚠️ 两套名字不可混用（踩过两次的坑）
 *
 * | 名字来源 | 示例 | 用途 |
 * |---|---|---|
 * | **目录 key**（本表） | `qfmodel` / `dmodel` | **加密端点**的 `model` 字段 |
 * | 通用名 | `qwen-flash` / `qwen-plus` | 公开端点的 `model` 字段（**不是**同一批模型） |
 *
 * 早期误把目录 key 发给公开端点 → `Unsupported model`；
 * 又误以为只有 11 个可用 → 表里换成通用名，结果拿到的是 Qwen3.5/2.5
 * 而非 Qwen3.8 系列（用户报障）。
 *
 * ## 数据来源
 *
 * 从本机 Qoder 的 `~/.qoder/.models/{uid}/catalog-v6` 解密取得
 * （`model_cache_decrypt`），字段逐项实测。
 *
 * ## 字段口径
 *
 * - `contextWindow`：目录 `max_input_tokens`。
 * - `supportsImage`：目录 `is_vl`（实测全为 true）。
 * - `supportsThinking`：目录 `is_reasoning`。
 * - `isFree`：目录 `is_free`（仅 Qwen3.8-Max / Qwen3.8-Flash）。
 * - `priceFactor`：目录 `price_factor`（**实测 2026-09-21，逐条对照本机
 *   catalog-v6 的 `chat` 场景**）。注意 `qfmodel` 的值是 **0**（免费），
 *   0 是合法值不能当缺失处理。
 * - `originalPriceFactor`：目录 `original_price_factor`（仅部分模型下发）。
 * - `promotion`：目录 `promotion`（错峰折扣，三档实测）。
 * - `efforts`：目录 `thinking_config.enabled.efforts` 的键。
 */
const QODER_FALLBACK_MODELS = [
    // ⚠️ 全部数值逐条对照本机 catalog-v6 实测（2026-09-21）。早期版本多处为
    // 手工估值，与真实值**大范围不符**（14 个模型有偏差，如 `smodel` 写 3.2
    // 实际 8、`qmodel_38max` 写 0.5 实际 0.2），用户据此报障。
    // 改动本表时必须重新对照 catalog，不要凭印象填。
    //
    // 字段顺序：id, 展示名, 上下文, vl, reasoning, free, 倍率
    //
    // ⚠️ `contextWindow` 取官方档位表 `context_config` 的**最大档**，不是 `max_input_tokens`
    // —— 与本文件 CN 表的同一口径，完整论证见那份表的注释与 AGENTS.md「2.1」。
    // 国际版客户端里该判定的实现与 CN **逐字符同构**
    // （`function LV(A,e){…let i=Jqr(A);if(i)return i.includes(t);…max_input_tokens…}`，
    // 由 `scripts/probe-qoder-intl-window-logic.mjs` 复核），故同一条结论成立。
    // 本表 17 条的档位表实测（`scripts/probe-qoder-windows.mjs intl`）：
    // 除 `auto` 无档位表外**全部含 1M 档**（`performance` 是 {272K,400K,1M}、
    // `efficient` 默认档为 400K）。
    //
    // ⚠️ **国际版的「服务端真能收多少」未实测**：`api2.qoder.sh` 在本机网络下
    // 恒定 HTTP/2 `NGHTTP2_INTERNAL_ERROR`（连 1K 的最小请求也不通），
    // 故本表依据是「客户端逻辑 + 目录档位表」，**不是** CN 那样的实发验证。
    // 若将来国际版可用，应按 `probe-qoder-context-needle.mjs` 复核一遍。
    //
    // ⚠️ **思考档位**（`efforts` / `defaultEffort` / `supportsDisable`）逐条对照
    // 客户端算法复刻结果（`scripts/probe-qoder-effort-fields.mjs`，按 `$lc` 顺序
    // 逐字段试、再过白名单 `Qj`）。本表的档位来自目录 `thinking_config.enabled.efforts`。
    { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: false, priceFactor: 0.5 },
    { id: 'ultimate', name: 'Ultimate', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 2, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high', supportsDisable: true },
    // ⚠️ `is_reasoning: false` 但 `thinking_config.enabled` 为真 —— 上游确实
    // 提供档位选择，故 `efforts` 保留；而请求体的 `isReasoning` 取 `is_reasoning`。
    // ⚠️ 档位表是 {272K(default), 400K, 1M}，取最大档。
    { id: 'performance', name: 'Performance', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 1.1, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'medium', supportsDisable: true },
    // ⚠️ 档位表 {200K, 400K(default), 1M} —— 唯一默认档不是 200K 的国际版模型。
    { id: 'efficient', name: 'Efficient', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.3 },
    // ⚠️ `smodel` / `cmodel` 有 5 档但**无 `disabled` 分支** → 不能关闭思考。
    { id: 'smodel', name: 'Sonus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 8, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
    { id: 'cmodel', name: 'Cantus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 4, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
    // 免费额度模型（is_free=true）：e2e 探针默认用它们以免消耗积分。
    // ⚠️ `priceFactor` 是**采集时刻的生效价**（窗口内为折后价），原价在
    // `promotion.beforePromotionPriceFactor`；展示时本地推算当前价。
    {
        // ⚠️ 默认档与国际版其他模型不同：这里是 `xhigh`（CN 同模型是 `medium`）。
        id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
        isFree: true, priceFactor: 0.2, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'xhigh', supportsDisable: true,
        promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
    },
    {
        // ⚠️ `priceFactor: 0` 是**免费**（实测），不是缺失 —— 见接口注释。
        id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
        isFree: true, priceFactor: 0, originalPriceFactor: 0.1, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', supportsDisable: true,
    },
    // ⚠️ 这两个模型目录里**只有 `disabled` + `enabled.is_default`，没有 `efforts`**
    // —— 即官方只提供「关闭思考」一个选项（用户 2026-09-28 确认：
    // 「上面两个没有思考档位就是关闭的意思」）。故 `efforts` 留空，
    // 由 `supportsDisable` 表达，适配器会追加 `none`（复刻客户端 `gU()`）。
    {
        id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false,
        priceFactor: 0.1, originalPriceFactor: 0.5, supportsDisable: true,
        promotion: { active: true, discountFactor: 0.2, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 2 折' },
    },
    {
        id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false,
        priceFactor: 0.04, supportsDisable: true,
        promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.1, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
    },
    { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 1.4, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
    // ⚠️ 该模型**未下发 `max_input_tokens`**（这正是「该字段不是权威值」的旁证）——
    // 旧表因此退回 `context_config` 的**默认档** 200K，但官方客户端给用户选的是
    // **最大档** 1M（`zX()` 只查成员资格，不限于默认档）。故取 1M。
    { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
    { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
    { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max'], defaultEffort: 'max' },
    { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5, efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true },
    { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max', 'low'], defaultEffort: 'max', supportsDisable: true },
    { id: 'mmodel', name: 'MiniMax-M3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.2 },
];
/** Qoder provider 配置（国际版）。 */
export const QODER = {
    id: 'qoder',
    displayName: 'Qoder',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    inferBase: 'https://api2-v2.qoder.sh',
    encryptedInferBase: 'https://api2.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    testClientId: 'e93fe488-5778-4c35-a6fc-0f54ed7b3139',
    clientMetadata: {
        client_type: '5',
        business_product: 'cli',
        business_type: 'agent',
        scene: 'assistant',
    },
    // 官方桌面客户端身份（源码常量 `Mh.clientType`）。仅用于 `/sash/` 端点。
    sashClientType: '10',
    userAgentPrefix: 'qoder',
    defaultCredentialRef: 'QODER_ACCESS_TOKEN',
    fallbackModels: QODER_FALLBACK_MODELS,
};
/**
 * 中国版模型目录（**实测数据**，2026-09-27，设计文档 E6）。
 *
 * 来源：本机 `~/.qoder-cn/.models/{uid}/catalog-v6` 的 `chat` 场景，
 * 用**国际版那份** WASM 解密（见 E5），共 14 条。
 *
 * ⚠️ **不能沿用国际版那张 17 条的表**：
 * - CN 独有 `q37fmodel` / `gm51model`；
 * - CN **没有** `ultimate` / `performance` / `efficient` / `smodel` / `cmodel`
 *   —— 沿用会让菜单出现 5 个 CN 端点根本不认的模型，点了就报错；
 * - 5 条上下文窗口、4 条思考标记、1 条 vl 标记不同；
 * - `mmodel` 在 CN 是 **MiniMax-M2.7**（国际版 M3）。
 *
 * ⚠️ CN 目录条目的标识字段名是 **`key`**，国际版是 `model_key` —— 只影响
 * 重新采集时的解析（`scripts/probe-qodercn-catalog.mjs` 两个名字都认），
 * 不影响本表（本表已是扁平结构）。
 *
 * 字段口径与国际版表完全一致，见 `QoderFallbackModel` 的注释。
 */
const QODER_CN_FALLBACK_MODELS = [
    // ⚠️ 全部数值逐条对照本机 CN catalog-v6 的 chat 场景实解值（2026-09-27）。
    // 国际版曾因为「手工估值 + 单测只断言 id 列表」让价格漂移长期未被发现
    // （14 个模型有偏差，用户报障）。改本表必须重新跑探针对照。
    //
    // ⚠️ **`contextWindow` 取官方档位表 `context_config` 的最大档，不是 `max_input_tokens`。**
    //
    // 两个字段经常自相矛盾（CN `dmodel`：`max_input_tokens: 96000`，档位表却是
    // `{200K, 400K, 1M}`），而**官方客户端只认后者**：`isContextWindowSupportedByModel()`
    // 把值换算成整数后交给 `zX()`，`zX()` 一旦发现档位表存在就**只检查「是否为表内成员」**，
    // 那条 `max_input_tokens` 兜底分支（`t <= n`）根本不会执行
    // （asar 证据：`function zX(A,e){…let i=Yai(A);if(i)return i.includes(t);…}`）。
    // 故照 `max_input_tokens` 填（180K / 96K）会让 DSH 远早于官方能力就触发压缩。
    //
    // 实测（2026-09-27，CN 网关加密端点，`scripts/probe-qoder-context-needle.mjs`）：
    // `max_input_tokens` 与 `parameters.context_length` **都不构成**服务端约束 ——
    // 同一份 400K 提示在声明 180K / 200K / 1M / 不发该字段时**全部完整送达**
    // （`prompt_tokens` 一致）；声明 96K 的 `dmodel` 也照收 852K。
    //
    // ⚠️ **上限因模型而异，不是网关统一值**（这是被实测推翻的早期结论）。
    // 逐模型实测的最大通过量（针埋在提示正中间，命中即证明未被截断）：
    //
    // | 模型 | 实测通过最大 | 服务端实际计入 | 越界点 | 越界错误形态 |
    // |---|---|---|---|---|
    // | `dfmodel` | 938,000 目标 | **999,991** | ≈1,002,000 | `Internal Server Error` |
    // | `qfmodel` | 984,000 目标 | **983,490** | 990,000 | 参数错误 + `Range … [1, 983616]` |
    // | `dmodel` | 800,000 目标 | **852,951** | 985,000 | `Internal Server Error` |
    //
    // ⚠️ **`983,616`（`1M − 16K`）只对报了它的那个模型成立，不能推广成全局上限** ——
    // `dfmodel` 实测通过到 999,991，已超过该数。
    //
    // ⇒ **取值口径（用户 2026-09-27 定）**：**档位表有 1M 档就填 1M**。
    // - `qfmodel` / `dfmodel` / `dmodel` 及以下各条：**填 1M**。
    //   `qfmodel` 与 `dfmodel` 的实测已逼近 1M（983,490 / 999,991）；
    //   `dmodel` 的实测只到 852,951（985,000 越界），但它是**档位表成员 1M**
    //   —— 采信官方档位表，且 1M × 0.8 = 800K 的压缩阈值低于 852,951 这个
    //   已知安全点，故填 1M 在 DSH 侧安全。
    // - `mmodel`：档位表**只有 200K 一档**，故填 200K。
    // - `auto`：无档位表，沿用 200K。
    //
    // ⚠️ **思考档位**（`efforts` / `defaultEffort` / `supportsDisable`）逐条对照
    // 客户端算法复刻结果（`scripts/probe-qoder-effort-fields.mjs`）。三条口径：
    // - `efforts` 取自目录 `thinking_config.enabled.efforts` 的**键**（目录原序）；
    // - `defaultEffort` 取该对象里 `is_default: true` 的键；
    // - `supportsDisable` = 目录存在 `thinking_config.disabled` 分支。
    // ⚠️ **`qmodel` / `qmodel_latest` 只有「关闭思考」**：目录里它们的 `enabled`
    // **没有 `efforts` 键**，只有 `disabled` + `enabled.is_default` ——
    // 即官方就只提供「关」这一个选项（用户 2026-09-28 确认：
    // 「上面两个没有思考档位就是关闭的意思」）。不要给它们补默认档位。
    // ⚠️ `q37fmodel` / `mmodel` / `auto` **连 `thinking_config` 都没有** →
    // 完全不可选（界面显示「当前模型未提供推理等级」，与 IDE 的「不支持」一致）。
    { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5 },
    // 免费额度模型（isFree=true）：e2e 探针默认用它们，以免消耗积分。
    {
        id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
        isFree: true, priceFactor: 0.2, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', supportsDisable: true,
        promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
    },
    {
        // ⚠️ `priceFactor: 0` 是**免费**，不是缺失 —— 0 是合法值，不能用 `> 0` 过滤。
        // 实测最大窗口：984,000 目标 → 服务端计入 **983,490**（越界点 990,000，
        // 越界时服务端回 `Range of input length should be [1, 983616]`）。填 1M。
        id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
        isFree: true, priceFactor: 0, originalPriceFactor: 0.1, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', supportsDisable: true,
    },
    {
        // ⚠️ **没有 `efforts`，只有「关闭思考」**（见本表前的口径注释）。
        id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
        priceFactor: 0.1, supportsDisable: true,
        promotion: { active: true, discountFactor: 0.2, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰2折' },
    },
    {
        // ⚠️ 同上：只有「关闭思考」。
        id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
        priceFactor: 0.04, supportsDisable: true,
        promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.1, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰4折' },
    },
    // CN 独有：Qwen3.7-Flash（国际版目录无此 key）
    // ⚠️ 目录里**完全没有 `thinking_config`** → 不可选档位（IDE 显示「不支持」）。
    { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1 },
    // ⚠️ CN 的 `max_input_tokens` 是 96000，但档位表与其它模型一样有 1M 档；
    // 官方客户端只认档位表 → **填 1M**（用户 2026-09-27 定：档位表有 1M 就填 1M）。
    // 实测只探到 800,000 目标 → 服务端计入 **852,951** 通过，985,000 时越界且
    // **只回 `Internal Server Error`（未给出区间）**，故它的真实天花板未探明；
    // 但 1M × 0.8 = 800K 的压缩阈值低于 852,951 这个已证安全点，故 1M 在 DSH 侧安全。
    { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5, efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true },
    // ⚠️ CN 的 `is_reasoning` 为 false（国际版为 true），故不声明 supportsThinking。
    // 实测最大窗口：938,000 目标 → 服务端计入 **999,991** 通过（连续 3 次可复现），
    // 939,000 时越界（`Internal Server Error`）→ 真实上限≈1,000,000。填 1M。
    { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.1, efforts: ['high', 'max', 'low'], defaultEffort: 'max', supportsDisable: true },
    // ⚠️ `gmodel` / `gfmodel` / `kmodel*` 有档位但**无 `disabled` 分支** → 不能关闭。
    { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
    { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max'], defaultEffort: 'max' },
    // CN 独有：GLM-5.2（国际版目录无此 key）
    { id: 'gm51model', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.6, efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true },
    { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImage: true, priceFactor: 1.4, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
    { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
    // ⚠️ 版本是 **M2.7**（国际版 M3），且 CN 的 `is_vl` 为 false，故两个标记都不写。
    // ⚠️ 唯一档位表只有 200K 一档的 CN 模型 —— 不要跟着其它条改成 1M。
    // ⚠️ 目录里也**没有 `thinking_config`** → 不可选档位（与 IDE「不支持」一致）。
    { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 200_000, priceFactor: 0.2 },
];
/** Qoder provider 配置（**中国版**）。 */
export const QODER_CN = {
    // ⚠️ id 不带连字符：它同时是 cordis 服务名（`qodercnAuth`）、LLM 路由名
    // （`llm-qodercn`）与凭据 ref 前缀（`QODERCN_ACCESS_TOKEN`）的组成部分，
    // 带连字符会让服务名不符合 camelCase 惯例。
    id: 'qodercn',
    displayName: 'Qoder (中国版)',
    // E4：CN endpoint-cache.json + asar `environments.prod`（website/auth/collaboration
    // 三个都指向 qoder.cn，openApi 指向 openapi.qoder.com.cn）。
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    // ⚠️ CN **没有**可用的公开 OpenAI 兼容端点：实测
    // `gateway.qoder.com.cn/model/v1/chat/completions` 与
    // `openapi.qoder.com.cn/model/v1/chat/completions` 都回 503（alb 无上游路由）。
    // 而 `inferBase` 在本代码里**没有任何调用方**（公开端点方案早已被加密
    // 端点取代，见 `QODER_CHAT_PATH` 同样无人使用），故这里填成与
    // `encryptedInferBase` 同值仅表示「没有独立公开端点」，**不要**据此发请求。
    // 不删该字段：删除属于与本任务无关的重构，且会牵动国际版注释。
    inferBase: 'https://gateway.qoder.com.cn',
    // E4 + E9：`algo` 网关在 CN 换域名，路径与协议同形
    // （零凭据 POST 的错误响应形态与国际版逐字节一致）。
    encryptedInferBase: 'https://gateway.qoder.com.cn',
    // E2：取自 CN asar 的 `Vpe.authClientIds.prod`。
    // ⚠️ **与国际版完全不同** —— 国际版两个 id 在 CN asar 里命中 0 次。
    // 用错的症状是「授权页 302 正常、点击授权后报参数无效」，
    // 故**不能**靠探测入口验证，必须真实登录闭环（tests/e2e/qodercn-probe）。
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    // E2：CN 的 `authClientIds.test` 与 `prod` **同一个值**，因此不存在国际版
    // `J_a` / `G_a` 被读反的那类风险。字段仍保留以免改动 `QoderProduct` 形状。
    testClientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    // 沿用国际版的 **CLI** 身份（源码 `Fp()` 默认值）。
    // ⚠️ CN 桌面端自己用的是 `Fh`（clientType 10 / businessProduct 'app' /
    // sessionType 'app' / scene 'app'）。插件走 CLI 身份在国际版实测可用；
    // CN 是否接受由 e2e 对话探针验证 —— 若被拒，改这一组值，
    // 但**不要**顺手把下面 `sashClientType` 一起改（那是两个不同身份，
    // 见 `QoderProduct.sashClientType` 的注释）。
    clientMetadata: {
        client_type: '5',
        business_product: 'cli',
        business_type: 'agent',
        scene: 'assistant',
    },
    // E10：CN asar 里同样是 `Fh = Object.freeze({ clientType: 10, … })`。
    sashClientType: '10',
    // E11：CN asar 的 sash 请求头 UA 恒为 `"Qoder"`，与国际版一致。
    userAgentPrefix: 'qoder',
    defaultCredentialRef: 'QODERCN_ACCESS_TOKEN',
    fallbackModels: QODER_CN_FALLBACK_MODELS,
};
/**
 * 全部 Qoder 产品配置（国际版 + 中国版）。
 *
 * 顺序即 `qoderProductById()` 的查找顺序，也是续期调度遍历的顺序。
 * 新增同族产品（如将来的其它区域版本）只在此追加一项 + 一份配置，
 * **不要**复制 `src/qoder*.ts` 的任何实现文件。
 */
export const ALL_QODER_PRODUCTS = [QODER, QODER_CN];
/**
 * 按 provider id 取 Qoder 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` 分开：
 * 三者返回**不同类型**，合并会让调用方拿到联合类型后不得不做类型收窄。
 */
export function qoderProductById(id) {
    return ALL_QODER_PRODUCTS.find((product) => product.id === id);
}
//# sourceMappingURL=qoder-product.js.map