/**
 * 让 DSH 官方的 `web_search` 在 **buddy 系渠道**下走腾讯原生后端。
 *
 * ## 这个模块解决什么
 *
 * DSH 的搜索走 Host 的 `ctx.web` seam，默认 provider 是 `deepseek-official`
 * （`web-search-deepseek`）：它只认 DeepSeek 账号令牌与 `DEEPSEEK_API_KEY`，
 * 而账号令牌分支写死了 `provider === 'deepseek-account'`。于是 buddy / workbuddy
 * 路由下搜索必然落到 API Key 路径，没有 key 就报
 * `WEB_PROVIDER_CREDENTIAL_MISSING`。
 *
 * 而腾讯客户端**自带**原生搜索（`/agenttool/v1/search`），与聊天同源、同账号。
 * 本模块把那个端点接到官方工具上。
 *
 * ## ⚠️ 只管 `web_search`，**刻意不管** `web_fetch`（2026-10-14 修正）
 *
 * 本模块早期同时接管了 `web_fetch`（`/agenttool/v1/webfetch`），**那是净损失**，
 * 现已整体剔除。理由（三条，均有实测依据）：
 *
 * 1. **官方 fetch 根本不需要凭据**：宿主 `cordis.yml` 里
 *    `web.fetchProvider: http` → `@deepseek-ai/dsh-web-fetch-http`，官方文档原话
 *    「**不发送凭据**」，零配置、自带 SSRF 防护与明确响应上限（5 MB / 100k 字符）。
 *    实测：本机删掉 `DEEPSEEK_API_KEY` 后它照样 200。
 *    ⇒ 接管它**没有换来任何能力**（不像 search —— 那个官方**要** key）。
 * 2. **复杂表格塌陷**：同一份 `api-docs.deepseek.com/.../pricing` 页面，官方保留
 *    `| a | b |` 的行列结构，腾讯原生把整表挤成一行 ⇒ 模型读不出「哪个数字对应
 *    哪个模型」。而查文档/查价格恰是 fetch 最常被用的场景。
 * 3. **依赖账号有效**：账号过期时腾讯 fetch 直接失败；官方永远可用。
 *
 * （腾讯 fetch 确有独到之处：返回页面 `标题` 与多语言全文。但代价是表格结构丢失，
 *  用户 2026-10-14 权衡后决定撤回。）
 *
 * ## 设计约束（用户明确要求）
 *
 * 1. **替换，不新增**：不注册新工具、不加提示词、不改 schema —— 模型无感。
 * 2. **跟随渠道**：当前会话用什么渠道，就用那个渠道的原生搜索。
 * 3. **只做 buddy 系**：`buddy` + `workbuddy` 两条，其余一概不碰。
 * 4. **不回退、不路由**：判断不通过就 `return next()`，官方链路逐字节不变。
 *
 * ## 为什么挂在 `tools/execute`
 *
 * `tools/execute` 是 Cordis 的 **waterfall**：`next()` 就是「执行原工具体」。
 * 不调 `next()` 直接返回 `{ value }` ⇒ 官方工具体不执行，但返回值仍会被
 * `createSuccessResult(exec, 原工具, value)` 用**原工具自己的** `output.schema`
 * 校验、用它的 `render` 渲染 ⇒ 模型看到的结果与官方**同构**。
 *
 * 实测（cordis 4.0.2）：不调 `next()` 时内层工具体确实不执行，故**必须**返回
 * `{ value }` 形状。若返回 `undefined`，宿主会在 `normalizeDispatchResult` 里
 * 读 `result.isError` 而抛 `TypeError`，被外层 catch 转成一句无意义的
 * `Error: Cannot read properties of undefined (reading 'isError')` ——
 * 模型拿不到任何有用信息。（此条为**宿主源码推断**，未在真实宿主实跑。）
 *
 * ## 与插件既有行为的一致性
 *
 * 选号复用适配器自己的 `resolveCredentialFor()`（转发到聊天链路用的同一个
 * `resolveCredential`），因此「哪些号可用、选哪个号」与聊天完全一致。
 *
 * @module
 */
import { NativeSearchCodes, WebNativeError, } from './native-search-contract.js';
/**
 * 单次搜索返回的 source 上限。
 *
 * ⚠️ **写死 8**：这是官方 `@deepseek-ai/dsh-tool-web` 的 `searchMaxResults`
 * schema 默认值（`WEB_SEARCH_MAX_RESULTS = 8`），但它是该包的**闭包变量**，
 * 未暴露到任何服务上，外部拿不到。
 *
 * 后果需知：若部署在 `cordis.yml` 里覆盖了 `tool-web.searchMaxResults`，
 * 本模块仍按 8 截断 —— 已知的、可接受的偏差（见模块头的「替换」约束）。
 *
 * ## 这个 8 有双重身份，不是巧合
 *
 * 它**同时**是「发给上游的 `max_results`」和「本地合并后的截断上限」：
 * - **上游侧**：实测 `max_results` 完全生效，1/3/5/8 原样返回、>8 一律封顶 8
 *   （见 `docs/workbuddy-native-search-research.md` §6.5）⇒ 上游已按 8 限流；
 * - **本地侧**：多 query 合并后仍需 cap（seam 的 `capSources()` 被短路跳过）。
 *
 * ⚠️ 双重截断可能导致**静默少结果**：若上游对 `max_results` 的理解与「返回条数」
 * 不同（例如按候选池计），本地去重后再截会让最终条数少于 8。属可接受的保守行为
 * ——少给总比超发安全，且上游实测行为已确认是按返回条数。
 */
const MAX_RESULTS = 8;
/**
 * 单次调用允许的 query 数上限。
 *
 * 与 {@link MAX_RESULTS} 同源：官方 `WEB_SEARCH_MAX_QUERIES = 4`，同样是
 * `dsh-tool-web` 的闭包变量、外部拿不到，故写死并在此注明依据。
 */
const MAX_QUERIES = 4;
/** 官方 `web_search` 工具名。 */
const WEB_SEARCH = 'web_search';
/**
 * 把原生搜索挂到官方 web 工具上。
 *
 * @param ctx - 插件上下文（`tools/execute` 由它派发）。
 * @param adapters - 两个 buddy 系渠道的适配器；**必须是聊天链路用的那两个实例**。
 * @param isEnabled - 「渠道原生搜索」总开关。返回 `false` 时**所有渠道**（含 buddy 系）
 *   一律 `next()` 回官方搜索。⚠️ **每次调用都会求值**，调用方不要在这里做缓存 ——
 *   用户随时可能在 Jet Hub 面板里切换它。
 */
export function installWebNative(ctx, adapters, isEnabled) {
    ctx.inject(['tools'], (scope) => {
        // 局部收窄：`tools/execute` 的类型由 `dsh-tools` 声明，本插件不依赖那个包
        //（理由见上方的 `ToolExecuteScope` 说明）。这是一次**刻意的**断言，
        // 不是随手写的 `as any` —— 收窄后的接口就是本模块真正读写的全部字段。
        const toolScope = scope;
        toolScope.on('tools/execute', async (exec, next) => {
            // ① 只管官方 `web_search`，其余一概放行。
            //
            //    ⚠️ **刻意不管 `web_fetch`**（2026-10-14 修正，理由见模块头）：
            //    官方 fetch 走 `web-fetch-http` 提供方（`fetchProvider: http`），
            //    **不发送凭据**、零配置、自带 SSRF 防护与明确响应上限。接管它是净损失
            //    —— 实测三点：复杂表格会塌成一行、依赖账号有效、且解决不了任何问题
            //    （search 要接管是因为官方**要** API key，fetch 本来就不需要）。
            //    ⇒ 任何渠道的 `web_fetch` 都走官方，我们不碰。
            if (exec.name !== WEB_SEARCH)
                return next();
            // ② 总开关。关掉即**所有渠道**回官方搜索 —— 与「只做 buddy 系」不同，
            //    这一条对 buddy 系**也**生效（用户显式要求「要么都用原生要么都用官方」）。
            //    ⚠️ 必须放在渠道判断**之前**：关掉时不该有任何渠道被我们接管。
            if (!isEnabled())
                return next();
            // ③ 读当前会话的路由。与官方 `read_image` 的 `assertImageCapableRoute`
            //    同一手法（`exec.agent.session.requestHeader().config`）。
            const route = exec.agent?.session.requestHeader()?.config;
            const channel = route?.provider;
            if (channel === undefined)
                return next();
            // ④ 只做**注册了适配器**的渠道。**没有 else 分支** —— 不通过即 `next()`
            //    原样放行，官方链路（`runSearchQueries` → `ctx.web.search` → DeepSeek
            //    provider）逐字节不变。
            //
            //    ⚠️ 必须用 `Object.hasOwn` 而不是直接下标取值（真实缺陷，对抗性审查 M3）：
            //    表是对象字面量，`channel` 取到原型链上的名字时查找会命中
            //    （`'constructor'` → `Object.prototype.constructor`，truthy 且非 `undefined`），
            //    于是守卫失效、进入短路分支。虽然要求会话路由的 provider 恰为这些字符串
            //    （可达性低），但守卫写法本身必须成立。
            if (!Object.hasOwn(adapters, channel))
                return next();
            const adapter = adapters[channel];
            // ⑤ 短路：返回 `{ value }`，官方工具体不执行。
            return { value: await runNative(exec, adapter) };
        });
    });
}
/**
 * 解析凭据、调上游搜索、按官方规则合并。
 *
 * ⚠️ 这里**不关心具体渠道**：取数（含凭据校验与字段投影）全在适配器的
 * `searchOnce` 里，本函数只做「官方语义」那部分（凭据判空 + 多 query 合并）。
 */
async function runNative(exec, adapter) {
    const model = exec.agent?.session.requestHeader()?.config?.model;
    // ⚠️ 与聊天链路同一个 `resolveCredential` 实例：筛号规则（enabled / 模型级
    //    限流 / 免费判定 / 余额分档 / 池兜底）因此完全一致。
    const credential = await adapter.resolveCredentialFor(model);
    const args = asRecord(exec.arguments) ?? {};
    return await nativeSearch(args, adapter, credential, exec.signal);
}
/**
 * 调上游搜索并投影成官方 `web_search` 的 output value。
 *
 * 官方入参是 `queries: string[]`（1~4 个，结果按 rank 轮转合并），故这里对
 * 每个 query 各发一次，再按官方 `mergeSearchResults` 的规则合并。
 *
 * ⚠️ **取数走适配器的 `searchOnce`**（各渠道自己实现，含凭据校验与字段投影），
 * 本函数只管「官方语义」那部分：入参校验、并发中止、rank 轮转合并、cap。
 */
async function nativeSearch(args, adapter, credential, signal) {
    const queries = readQueries(args.queries);
    // ⚠️ 复刻官方 `runSearchQueries` 的并发语义：**一方失败即中止其余，且等全部
    //    settle 后才重抛首个失败**（宿主 `tool-web/src/search.ts` 用的是
    //    `AbortController` + `controller.abort(error)` + `await Promise.allSettled`）。
    //
    //    裸 `Promise.all` 不行（真实缺陷，对抗性审查 M1/探针 F7）：首个失败会
    //    **立即**抛出，兄弟请求既不被 abort、也无人等待 —— 它们在后台跑完，
    //    白白消耗账号配额（搜索是计费/限流动作）。
    const controller = new AbortController();
    const batchSignal = AbortSignal.any([signal, controller.signal]);
    let firstFailure;
    /**
     * ⚠️ 用 `Map` 而不是稀疏数组 —— **这是纯防御，不是已证实的缺陷**。
     *
     * 失败时 `perQuery[index]` 不会被赋值，理论上会让下面的 `result.length` /
     * `result[rank]` 抛 `TypeError`。但实测（对抗性审查第二轮 Major-2）：把本处
     * 三行一并改回数组、再去掉可选链，**45 个用例仍全绿** —— 因为 `catch` 里
     * 必然设置 `firstFailure`，紧接着就会抛出，**失败路径根本走不到合并段**。
     *
     * 故本处**没有任何可观测的行为差异**，保留它只为把「顺序不变量」这层隐式
     * 依赖去掉：将来谁调整了「先抛后合并」的顺序，也不会因此崩。
     */
    const perQuery = new Map();
    const searches = queries.map(async (query, index) => {
        try {
            perQuery.set(index, await adapter.searchOnce(query, credential, batchSignal));
        }
        catch (error) {
            // 只记**首个**失败，与官方一致（后续失败不再覆盖归因）。
            if (firstFailure === undefined)
                firstFailure = { error };
            controller.abort(error);
            throw error;
        }
    });
    await Promise.allSettled(searches);
    if (firstFailure !== undefined)
        throw firstFailure.error;
    // 复刻官方 `mergeSearchResults`：按 rank 轮转 + url 去重 + cap。
    // ⚠️ 按 query 的**原始顺序**取出结果（`Map` 的插入顺序在并发下不保证等于
    //    `queries` 顺序），与官方 `results[index]` 的语义一致。
    const ordered = queries.map((_, index) => perQuery.get(index));
    const seen = new Set();
    const sources = [];
    let sourceRanks = 0;
    for (const result of ordered)
        sourceRanks = Math.max(sourceRanks, result?.length ?? 0);
    let truncated = false;
    merge: for (let rank = 0; rank < sourceRanks; rank++) {
        for (const result of ordered) {
            const source = result?.[rank];
            if (source === undefined || seen.has(source.url))
                continue;
            if (sources.length === MAX_RESULTS) {
                truncated = true;
                break merge;
            }
            seen.add(source.url);
            sources.push(source);
        }
    }
    return { sources, truncated };
}
/**
 * 读取 `queries` 参数并校验。
 *
 * ## ⚠️ 为什么这里必须自己校验
 *
 * 官方工具的入参校验**不在** `tools/execute` 之外，而在 `defineTool` 包装的
 * `execute` **内部**（宿主源码）：
 * ```js
 * async execute(args, exec) {
 *   const violations = validate(args)          // ← 官方 schema 校验
 *   if (violations.length > 0) throw new ToolArgsError(violations)
 *   return userExecute(args, exec)             // ← 真正的工具体
 * }
 * ```
 * 而本模块**短路了 `dispatchToolBody`** ⇒ 那个 `execute` 根本不执行 ⇒
 * **官方校验被整体跳过**。故这里必须复刻官方 `parseSearchArgs` 的判据，
 * 否则畸形入参会一路传到上游（错误从「参数不合法」变成「上游 4xx」，
 * 模型得到的指引完全不同）。
 *
 * 判据与官方逐条对齐：
 * - 空数组 → 抛错；
 * - 超过 `maxQueries`（4）→ 抛错；
 * - 任一项 trim 后为空 → 抛错；
 * - 去重（官方用 `new Set`，这里同时 trim，差异见下方注释）。
 *
 * ⚠️ **一处刻意的小差异**：官方 `parseSearchArgs` 用 `[...new Set(queries)]`
 * **不 trim** 就去重，故 `' a '` 与 `'a'` 在官方是**两个** query。这里先 trim
 * 再去重，会把它们合并成一个。选择 trim 的理由：搜索是**外部副作用**，
 * 多发一次重复查询既慢又浪费账号配额，而两者的搜索语义完全相同。
 * 该差异只在「模型传了仅空白不同的重复 query」时可见，属可接受的收敛。
 *
 * @param value - 原始的 `queries` 入参（可能是任何形状）。
 * @returns 归一化后的 query 列表。
 * @throws {WebNativeError} 入参不满足官方判据时。
 */
function readQueries(value) {
    if (!Array.isArray(value)) {
        throw new WebNativeError('queries must be an array of strings', NativeSearchCodes.invalidArgs);
    }
    if (value.length === 0) {
        throw new WebNativeError('queries must contain at least one query', NativeSearchCodes.invalidArgs);
    }
    if (value.length > MAX_QUERIES) {
        throw new WebNativeError(`queries must contain at most ${MAX_QUERIES} queries`, NativeSearchCodes.invalidArgs);
    }
    const out = [];
    for (const item of value) {
        if (typeof item !== 'string') {
            throw new WebNativeError('each query must be a non-empty string', NativeSearchCodes.invalidArgs);
        }
        const query = item.trim();
        if (query.length === 0) {
            throw new WebNativeError('each query must be a non-empty string', NativeSearchCodes.invalidArgs);
        }
        if (!out.includes(query))
            out.push(query);
    }
    return out;
}
/**
 * 把未知值收敛成记录；非对象（含 `null`、数组之外的一切）返回 `undefined`。
 *
 * ⚠️ 与「返回 `{}`」不同：调用方需要能区分「不是对象」与「是空对象」，
 * 前者要丢弃、后者可能是合法入参。搜索结果的逐项过滤依赖这个区分。
 */
function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : undefined;
}
//# sourceMappingURL=web-native.js.map