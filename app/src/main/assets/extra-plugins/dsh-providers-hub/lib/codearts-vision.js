/**
 * codearts 的**视觉能力事实** + `analyzeImage` 的**可见性判据**（无依赖叶子模块）。
 *
 * ## ⚠️ 为什么这些事实要独立成一个叶子模块
 *
 * 本模块有两个消费者，而它们在依赖图上**分居两侧**：
 *
 * 1. `analyze-image.ts`（工具层）—— 注册工具、并在执行期判「当前路由还用不用得着它」；
 * 2. `llm-register-compat.ts`（**适配器注册期**包装）—— 逐请求把该工具从
 *    **非 codearts 路由**的工具表里摘掉（2026-10-23 真实报障的修法，见下）。
 *
 * 第 2 个点若直接从 `llm-adapter.ts` 取谓词就会**成环**
 *（`llm-register-compat → llm-adapter → llm-register-compat`）⇒ 把「事实」
 * 下沉到这个**不 import 任何模块**的叶子，`llm-adapter.ts` 再反向 re-export
 * 保持既有导入路径不变（全仓只有这一处定义，不是第二套同义判据）。
 *
 * ## ⚠️⚠️ 为什么必须「按路由摘掉」，而不只是修 schema（真实报障，2026-10-23）
 *
 * 用户对 **codebuddy / workbuddy** 发消息**每轮必失败**：
 *
 * ```
 * 本轮运行失败workbuddy: 工具定义不合规，请新建任务重试 invalid function call parameters
 * INVALID_REQUEST
 * ```
 *
 * 取证链（会话 `session-8e5481b1` / `session-0a073d28`，2026-10-23）：
 *
 * | 证据 | 内容 |
 * |---|---|
 * | 落盘 `request/header` | 280 个工具里**唯一**一个 `parameters` 不是 `{type:'object',…}` 的就是 `analyzeImage`（当时是 `{}`） |
 * | **同会话对照** | 同一份 283 工具清单：`qoder` / `codearts` / `loomy` 全部正常产出，只有 `workbuddy` / `buddy` 硬 400 |
 * | 上游原文 | `{"code":11129,"msg":"invalid function call parameters","displayTips":{"zh":"工具的参数结构不符合当前模型要求，被服务端拒绝…"}}` |
 * | **真机 A/B** | 同账号同消息，只改那一个 schema：`{}` → **400**；`{type:'object',properties:{}}` → **200**（两站各自复现） |
 * | **整份清单** | 280 个工具原样 → **400**；只把 `analyzeImage` 换成正确形状 → **200** ⇒ 清单里没有第二个不合规定义 |
 *
 * ⇒ 「空 schema」是**传输缺陷**（已在 `analyze-image.ts` 修掉），而「别家根本不该看到
 * 这个工具」是**作用域缺陷**（本模块负责）。两者都要修：只修 schema 的话，腾讯之外的
 * 严格上游、以及模型误调用（执行期必然抛「不属于 codearts」）仍然会发生。
 *
 * ## ⚠️⚠️⚠️ 同一个根因在**三个**上游复现，错误码/文案/失败形态各不相同（2026-10-23 实测）
 *
 * 用户先报 buddy/workbuddy，随后报 TRAE 的 `4027`。**那是同一个缺陷**，只是各家的
 * 校验器说法不同 —— 而**失败形态**的差异会直接改变排查难度：
 *
 * | 渠道 | 错误码 | 文案 | HTTP | 藏在哪 |
 * |---|---|---|---|---|
 * | buddy `copilot.tencent.com` | `11129` | `invalid function call parameters` | **400** | HTTP 体 |
 * | workbuddy `www.workbuddy.ai` | `11129` | 同上（`displayMsg.zh` = 工具定义不合规） | **400** | HTTP 体 |
 * | **trae** | **`4027`** | **`tools.0.function.parameters must be a JSON Schema of type object`** | **200** | **流内**（`event:progress_notice` 之后） |
 *
 * 三条可推广的教训：
 *
 * 1. **`tools.0` 不是「第 0 个工具有问题」的通例，而是「问题工具恰好排在第 0 位」** ——
 *    本仓工具按名排序，`analyzeImage` 恰在首位 ⇒ 换 20 个 provider 它都是
 *    `tools.0`。排查时**必须**先解出 `tools.N` 是哪个工具，别被 `0` 误导成
 *    「工具表整体非法」。
 * 2. **只看 HTTP 码会把 TRAE 这类误判成成功**：它的 4027 是 HTTP 200 + 流内错误，
 *    与本仓 TRAE 那条「流内 `code=4006` 不得归 SERVER」（见
 *    `docs/agent-notes/providers-trae.md`）**同一形态** ⇒ 判「成功」必须看流是否
 *    产出了正文，而不是状态码。
 * 3. **判别力来自「只改那一个变量」**：TRAE 上同样跑了 A/B（原样清单 → 逐字复现 4027；
 *    只把 `analyzeImage` 换成 `{type:'object',properties:{}}` → 正常收尾），
 *    并复核了作用域摘除后**实发 279/280 且未修清单也不再被拒**。
 *
 * ⚠️ 与 TRAE 的既有笔记不冲突：`providers-trae.md` 记的是 `4001`（auth）/
 * `4006`（体积超限）两个码，`4027`（工具定义不合规）是**第三个**，此前无记载。
 *
 * ## ⚠️⚠️ 为什么不是「按 agent 作用域 restrict」—— 时序上做不到
 *
 * `dsh-tools` 确实有 `restrict({deny:[…]})`（按调用者作用域收窄**全局**工具），
 * 但它在 `dsh-agent-loop` 里**永远晚一步**：
 *
 * - `preStep()` 先 `systemPrompt.assemble(...)`（**工具表在这一次组装里就固化了**），
 *   之后才派发 `agent/pre-step` 瀑布 ⇒ 在 pre-step 里 restrict 影响的是**下一步**；
 * - `agent/request` 瀑布更晚（其文档原文：「On step admission, this runs **after
 *   assembly**」）；
 * - 而「用户刚选的新模型」只存在于 `dsh-api-session-controller` 的
 *   `modelSelection` 投影里（`{lastUsed, pending}`），插件侧读不到 ⇒
 *   组装那一刻拿不到「即将使用」的路由。
 *
 * 结果就是「从 codearts 切到 buddy 的**第一步**仍然会 400」—— 正是用户报的这个症状。
 * 故判据下沉到**适配器层逐请求求值**：那里 `options.provider` / `options.model`
 * 就是**本次请求的真实路由**，零时序、零状态、零竞态，且与本插件注册的**全部 20 个
 * 渠道**（含 buddy 系）同时生效。
 *
 * ⚠️ 已知边界（如实登记）：**非本插件注册的 provider**（harness 自带的官方 deepseek /
 * anthropic 等）不经过我们的包装 ⇒ 它们仍会在工具表里看到 `analyzeImage`（那些上游
 * 不校验工具定义、也不会因此失败，但模型可能误调用并被执行期判据拒绝）。
 * harness 目前**没有**「按路由呈现工具」的机制：官方 `read_image` 的做法同样是
 * 「全局注册 + 执行期断言」（见 `analyze-image.ts` 的 `assertImageCapableRoute` 同款）。
 *
 * ⚠️ 另一处已知边界：**聚合渠道**（`aggregate`）路由 id 不是 `codearts`，故即便它
 * 轮换到 codearts 的文本模型，本工具也会被摘掉 —— 这与修前的**执行期判据一致**
 *（`shouldOfferAnalyzeImage` 同样只认 `provider === 'codearts'`），不是新引入的回归。
 *
 * @module
 */
/**
 * codearts 的 provider id。
 *
 * ⚠️ 这个字面量在 `llm-adapter.ts` 里以 `PROVIDER` 具名 re-export —— 全仓
 * **只有这一处定义**（两条腿不一致会让「摘掉」与「断言」分叉）。
 */
export const CODEARTS_PROVIDER = 'codearts';
/**
 * `analyzeImage` 的工具名。
 *
 * 与 IDE 的同名工具保持一致 —— 模型在 IDE 语境下已熟悉这个名字，
 * 换名会让它在已有对话历史里找不到对应关系。
 */
export const ANALYZE_IMAGE_TOOL = 'analyzeImage';
/**
 * 能**原生收图**的 codearts 模型（`/v1/model/builtin` 的 `supports_images` 实测）。
 *
 * | 模型 | `supports_images` | `model_category` |
 * |---|---|---|
 * | `kimi-k2.6-vl` / `Qwen3-VL-235B` | **true** | 图片理解 |
 * | `glm-5.3` / `GLM-5.2` / `openpangu-*` / `deepseek-v4.1-flash` | false | 文本生成 |
 *
 * 其余模型发图必被上游拒：
 * `{"error_code":"InferHub.001001020.406","error_msg":"The request model is not multimodal"}`。
 */
export const CODEARTS_VL_MODELS = ['kimi-k2.6-vl', 'Qwen3-VL-235B'];
/**
 * `analyzeImage` 用哪个 VL 模型。
 *
 * ⚠️ 取 `kimi-k2.6-vl` 的**依据是 IDE 自己的选择**（不是我们猜的）：本机内核日志
 * `builtin-model-service` 实测 11 次采样全部是
 * `[fetchMultimodalModelId] Success, selected multimodal model: kimi-k2.6-vl,
 *  candidates: kimi-k2.6-vl, Qwen3-VL-235B` ⇒ IDE 恒定选它，我们跟随。
 */
export const CODEARTS_VISION_MODEL = 'kimi-k2.6-vl';
/** 该模型能否原生收图（大小写不敏感 —— 上游目录里两种写法都出现过）。 */
export function codeartsAcceptsImage(modelId) {
    const key = modelId.trim().toLowerCase();
    return CODEARTS_VL_MODELS.some((id) => id.toLowerCase() === key);
}
/** `analyzeImage` 用哪个 VL 模型（当前恒定返回 {@link CODEARTS_VISION_MODEL}）。 */
export function codeartsVisionModel() {
    return CODEARTS_VISION_MODEL;
}
/**
 * 判断**当前路由**该不该看到 `analyzeImage`。
 *
 * 判据三条，缺一不可：
 * 1. 路由 provider 是 `codearts`（别家的图片直发上游，不需要这个中转）；
 * 2. 该模型**收不了图**（VL 模型自己就能看，给它这个工具是多余的）；
 * 3. 路由信息可解析（拿不到就**不挂** —— 宁可少一个工具，也不要挂一个用不了的）。
 *
 * ⚠️ 本函数是**唯一定义处**：工具注册（`analyze-image.ts`）、执行期断言、
 * 以及注册期逐请求摘除（{@link withAnalyzeImageScoping}）三处共用它。
 *
 * @param provider - 路由的 provider id
 * @param model - 路由的 model id
 * @param accepts - 「该模型能否收图」的判据（默认用 codearts 的实现；注入以便单测）
 */
export function shouldOfferAnalyzeImage(provider, model, accepts = codeartsAcceptsImage) {
    if (provider !== CODEARTS_PROVIDER)
        return false;
    if (model === undefined || model.length === 0)
        return false;
    return !accepts(model);
}
/**
 * 把一个**不该看到 `analyzeImage` 的路由**的工具表里那一项摘掉（纯函数）。
 *
 * ⚠️ 三条纪律：
 * 1. **不原地改**调用方的对象与数组（工具表可能被宿主复用/比对）；只在真的要摘时
 *    才产生新对象；
 * 2. **该保留时返回同一个对象**（引用相等）—— 身份不变才不会让宿主的
 *    「工具表是否变化」判据产生假变化；
 * 3. **只动这一个名字**，其余工具（含 `read_image`）逐字透传。
 *
 * @param options - 本次 dispatch 的请求参数
 * @returns 原对象（保留）或摘掉该项后的浅拷贝
 */
export function stripAnalyzeImageTool(options) {
    if (shouldOfferAnalyzeImage(options.provider, options.model))
        return options;
    const tools = options.tools;
    if (tools === undefined || tools.length === 0)
        return options;
    const kept = tools.filter((tool) => tool?.name !== ANALYZE_IMAGE_TOOL);
    // 本来就没有这一项 ⇒ 不要为了「空操作」制造新对象
    if (kept.length === tools.length)
        return options;
    return { ...options, tools: kept };
}
/**
 * 把「非 codearts 路由的工具表里摘掉 `analyzeImage`」包到适配器上（**注册期**接线）。
 *
 * ## ⚠️ 为什么包在 `prepareCall` 返回的 `call.stream`（与 `dead-model-store` 同款）
 *
 * 宿主的生产路径是 `prepareCall(provider, model, signal)` → `call.stream(options)`；
 * 只包适配器自己的 `stream` 会被这条路绕开（PR !66 的教训：包装适配器必须包
 * `prepareCall`）。同时**也**包一份裸 `stream`：单测/诊断脚本（如
 * `scripts/dump-buddy-wire.mts`）会直接调它，两条口径必须一致。
 *
 * ⚠️ 路由取 `options.provider ?? prepareCall 的第一实参 ?? 注册的 ids[0]`：
 * dispatch 时的 `options.provider` 最贴近真实路由（`dsh-llm` 会带上），
 * `prepareCall` 的实参是次优来源（多路由适配器上它只是「本实例注册的其中之一」）。
 *
 * @param providers - 该注册持有的路由集合（用于兜底归属）
 * @param adapter - 原始适配器实例
 * @returns 包装后的适配器（**同一个实例身份要求**由调用方保证：这里返回 Proxy）
 */
export function withAnalyzeImageScoping(providers, adapter) {
    const ids = providers.filter((id) => typeof id === 'string' && id.length > 0);
    const target = adapter;
    const bound = new Map();
    /** 懒建一次并缓存，保证每次访问返回同一个函数（下游按函数身份缓存时不会失配）。 */
    const wrapOnce = (key, make) => {
        if (!bound.has(key))
            bound.set(key, make());
        return bound.get(key);
    };
    /** 归属：优先 dispatch 的 options.provider，其次 prepareCall 实参，最后注册 id。 */
    const providerOf = (preparedProvider) => {
        if (typeof preparedProvider === 'string' && preparedProvider.length > 0)
            return preparedProvider;
        return ids[0];
    };
    /**
     * 补上归属用的 `provider` 后再摘工具。
     *
     * ⚠️ `options.provider` 已有时**原样透传**（不加一层浅拷贝）—— 保留对象身份，
     * 宿主的「工具表/配置是否变化」判据才不会看到假变化；只有它缺席时才回退到
     * `prepareCall` 实参 / 注册 id。
     *
     * ⚠️⚠️ **这条回退腿实测无守卫（2026-10-23 变异验证，如实登记）**：把它换成
     * `if (false)` 后本组 30 条用例**全绿**。原因已查清：`dsh-llm` 的 `adapterStream`
     * （`@deepseek-ai/dsh-llm/lib/index.js:2321`）派发的是
     * `dispatch = (options) => adapterCall.stream(options)`，而那个 `options` 就是宿主
     * 组装好的 `GenerateOptions`（`provider` **必有**）⇒ 生产环境里这条腿**不可达**；
     * 只有「绕过 `prepareCall` 直接调裸 `stream`」的路径才会缺 `provider`，而那条路径
     * 又回落到 `ids[0]`（本仓 14 处注册都是单元素 ⇒ 即真值）⇒ 结果仍然正确。
     * ⇒ **不为它造恒真用例**（本仓老教训：无牙要如实登记，别编用例把它「修绿」）。
     * 若将来出现「provider 为空也真发上游」的路径，这腿失效会表现为
     * 「工具被误摘」而不是 400 —— 那种失败比 400 更难查，届时需补真机凭据。
     */
    const withRoutedProvider = (options, preparedProvider) => {
        if (typeof options?.provider === 'string' && options.provider.length > 0) {
            return stripAnalyzeImageTool(options);
        }
        return stripAnalyzeImageTool({ ...options, provider: providerOf(preparedProvider) });
    };
    return new Proxy(adapter, {
        get(obj, prop, receiver) {
            if (prop === 'prepareCall' && typeof target.prepareCall === 'function') {
                return wrapOnce(prop, () => async (...args) => {
                    const call = await target.prepareCall.apply(obj, args);
                    if (call === null || typeof call !== 'object' || typeof call.stream !== 'function')
                        return call;
                    return {
                        ...call,
                        stream: (options) => call.stream(withRoutedProvider(options, args[0])),
                    };
                });
            }
            if (prop === 'stream' && typeof target.stream === 'function') {
                return wrapOnce(prop, () => (options) => target.stream.apply(obj, [withRoutedProvider(options, undefined)]));
            }
            // 其余成员原样透传；方法需绑定原对象作为 this（Proxy 上没有私有字段，
            // 直接用 proxy 当 this 会让 `this.#x` 抛 TypeError；缓存绑定结果避免函数身份失配）。
            const value = Reflect.get(obj, prop, receiver);
            if (typeof value !== 'function')
                return value;
            return wrapOnce(prop, () => value.bind(obj));
        },
    });
}
//# sourceMappingURL=codearts-vision.js.map