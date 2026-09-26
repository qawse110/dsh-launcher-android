/**
 * SSE 流读取与工具参数归一化的共享工具。
 *
 * codearts 与 buddy 两个适配器都消费 OpenAI 风格的 SSE chat 响应，并面临
 * 同一类后端行为：网关在连接空闲一段时间后静默掐断，或模型在生成大工具
 * 参数期间长时间不 flush 任何字节。若不主动检测空闲，`reader.read()` 会
 * 无限期挂起——适配器的 generator 永不返回，harness 当前步骤既不出结果
 * 也不报错"，web 端表现为后续指令无响应。主动超时并把失败归类为可重试的
 * TIMEOUT，harness 才能重试该步骤，把控制权交还给用户。
 */
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm';
import { normalizeHarnessMessages } from './message-shape.js';
/**
 * 在空闲超时内读取一个流块。超过 {@link timeoutMs} 无数据则取消
 * reader 并抛可重试的 `LlmError('TIMEOUT')`——比被动等待网关掐断更早
 * 失败，且归类为可重试 code。尊重用户传入的 {@link signal}：若已 abort
 * 则直接抛 abort 原因，不误报超时。
 *
 * @param label - 提供者标签，仅用于错误消息前缀（如 'codearts' / 'buddy'）。
 * @param phase - 仅用于错误消息区分首 token 超时与 chunk 间超时。
 */
export async function readWithIdleTimeout(reader, timeoutMs, label, signal, phase = 'chunk') {
    if (signal?.aborted)
        throw signal.reason ?? new Error('aborted');
    let timer;
    const onUserAbort = () => { if (timer)
        clearTimeout(timer); };
    signal?.addEventListener('abort', onUserAbort, { once: true });
    const readPromise = reader.read();
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new LlmError(`${label}: sse ${phase} timeout after ${timeoutMs}ms`, 'TIMEOUT')); }, timeoutMs);
    });
    try {
        const result = await Promise.race([readPromise, timeoutPromise]);
        return { done: result.done, value: result.value };
    }
    catch (error) {
        // 用户取消：透传
        if (signal?.aborted)
            throw signal.reason ?? error;
        // 空闲超时：取消 reader 释放底层连接，再抛可重试 TIMEOUT
        if (error instanceof LlmError) {
            await reader.cancel().catch(() => { });
            throw error;
        }
        throw error;
    }
    finally {
        if (timer)
            clearTimeout(timer);
        signal?.removeEventListener('abort', onUserAbort);
    }
}
/**
 * 把工具调用的 arguments 文本归一化为合法的 JSON 对象字面量。
 *
 * 后端在两种情况下会给出非对象的 arguments：
 * - 无参数工具只下发一个空分片（`"arguments":""`），拼接结果为空串；
 * - SSE 流被截断（连接中断 / 网关掐断），只收到半截 JSON。
 *
 * 两者都会让 harness 解析参数时报
 * `invalid arguments: "arguments" must be an object`，并把会话卡在错误态
 * ——web 后续"继续"指令无响应。归一化为 `{}` 后，缺少必填
 * 参数的工具会走正常的 schema 校验错误并回传给模型，由模型重新发起调用，
 * 而不是让整个会话崩溃。
 */
/**
 * 工具名是否可用（非空字符串）。
 *
 * ⚠️ **不能用 `String(name).length > 0` 代替**：`undefined` / `null` 经 `String()`
 * 会变成 `"undefined"` / `"null"` 这类**非空**字符串，于是"缺名字"被误判成
 * "有名字"，原样发给上游照样 400。判据必须落在原始值上。
 */
export function hasUsableToolName(name) {
    return typeof name === 'string' && name.trim().length > 0;
}
/**
 * 判断一次响应是否为「零内容块」的退化补全，并给出 DSH 约定的 finish reason。
 *
 * ## 为什么必须有这条判据
 *
 * DSH 的 `EMPTY_RESPONSE` 契约（`dsh-llm/lib/index.js`）：
 *
 * > Providers occasionally emit a degenerate completion (a terminal stop with zero
 * > output); adapters classify it as this failure instead of yielding an empty
 * > assistant message, because **an empty message silently ends the turn with
 * > nothing for the user or the loop to act on**. The attempt produced nothing
 * > durable, so retry policy treats it as safe to repeat.
 *
 * 官方适配器 `dsh-llm-deepseek` 的写法（权威范本）：
 *
 * ```js
 * reason.kind === 'stop' && order.length === 0
 *   ? { kind: 'error', failure: { message: '…no content', code: EMPTY_RESPONSE_CODE } }
 *   : reason
 * ```
 *
 * ⚠️ **本判据是「压制纯空白思考」的必要配套**（Task 2 审查发现、控制方实测证实）：
 * 压制空块后，若该响应本来**只有**那个空白 reasoning 块（无 text、无 tool-call），
 * 就会产出「零块 + `finish: stop`」—— 正是上面契约要防的**静默结束**，
 * 与本项目已两次踩过的同族坑（空名 `tool_call`、死循环）完全同型。
 * 实测真实频率：**1 / 30404**（`scripts/quantify-empty-response-risk.ts`）。
 *
 * ## 只覆盖「否则会落到 stop」的情形
 *
 * 传入的 `reason` 若不是 `{kind:'stop'}`（例如已是 `max-tokens` / `tool-calls`），
 * **原样返回** —— 那些 reason 本身就表示「有不完整/有产出」，语义更具体，
 * 不应被泛化的零块判据覆盖（与官方范本一致：只在 `kind === 'stop'` 时才改写）。
 *
 * ## ⚠️ `code` 必须用 `EMPTY_RESPONSE_CODE` 常量，不得写字面量
 *
 * 重试资格由**字符串匹配**决定（`dsh-llm` 的 `resolveRetryPolicy` →
 * `policy.retryableCodes.includes(failure.code)`，默认集合含 `EMPTY_RESPONSE`）。
 * 硬编码 `'EMPTY_RESPONSE'` 一旦与上游常量漂移（改名、改前缀、加命名空间），
 * 匹配**静默失败** —— 于是本修复要消灭的「静默结束」会以「静默不退避重试」
 * 的形式原样回来，且编译期与测试都不会报错。
 * 根导出可用性已确认（`@deepseek-ai/dsh-llm` 的 `lib/index.js` 第 217 行
 * 即把 `EMPTY_RESPONSE_CODE` 放进 `DEFAULT_RETRYABLE_CODES`）。
 *
 * @param reason - 各适配器已算出的 finish reason。
 * @param blockCount - 本次响应**实际产出**的块数量（不含被压制的空块）。
 * @returns 零块且原为 `stop` 时返回 `error`/`EMPTY_RESPONSE`，否则原样返回。
 */
export function resolveEmptyResponseReason(reason, blockCount) {
    if (blockCount > 0 || reason.kind !== 'stop')
        return reason;
    return {
        kind: 'error',
        failure: {
            message: 'model returned a completed response with no content',
            code: EMPTY_RESPONSE_CODE,
        },
    };
}
/**
 * 行首空白思考（`trim()` 为空）的累积器。
 *
 * 为什么需要它：模型偶发只输出一个空格当思考（实测 2232 次，
 * `reasoningTokens=1`），会落成空 Think 块污染 UI 与提示词。
 * 而 `BlockAssembler` 在没有 `block-end` 时会用 `partial.text` 组装出块，
 * 故**不能**只在出口过滤 —— 必须从一开始就不发 chunk。
 *
 * ⚠️ 本 helper **不产出 chunk 对象**（它不该知道 `index`），只告诉调用方
 * 「该不该发、发什么文本」。调用方负责组装 `block-start` / `reasoning-delta`
 * 并写入 `block.text`。这样 `index` 的分配仍完全由调用方的 `nextIndex++` 掌控。
 *
 * 判据落在**整块**而非单片上：只有迄今累积文本 `trim()` 为空才压制；
 * 一旦整块出现过非空白字符，后续空白片就是**普通增量**，照常发出
 * （故 `["a", " "]` 的整块 `'a '` 被完整保留）。
 */
export function createBlankReasoningSuppressor() {
    let accumulated = '';
    // 是否已经「转正」（整块出现过非空白字符）。用布尔量而非每次重算 `trim()`：
    // 一旦转正就永不复位，故后续空白片不可能把块判回空白。
    let emitting = false;
    return {
        feed(text) {
            accumulated += text;
            if (emitting)
                return text;
            // 整块迄今仍是空白 ⇒ 一片都不发。调用方因此不会建块、不会消耗 nextIndex，
            // 纯空白思考便无从落成 `partial.text` 组装出的块。
            //
            // ⚠️ 判据用 `text.trim()`（**本片**）而非 `accumulated.trim()`（整段）：
            // 未转正期间此前所有片 `trim()` 皆为空，而全空白串拼接后仍全空白，
            // 故二者**语义等价**（已用变异测试证实）。但用整段会让「全空白流」退化成
            // O(n²)（每片重扫全部累积；128000 token 的病态流下约 1e9 次比较），
            // 而只看本片是 O(1)。
            if (text.trim() === '')
                return undefined;
            emitting = true;
            // 从空白转为非空白：补发**已累积的全部文本**（不是仅本片）——
            // 此前一片都没发过，只发增量会丢掉前导空白、与 wire 不符。
            return accumulated;
        },
        text() { return accumulated; },
    };
}
/**
 * 剔除无法配对、或**名称不可用**的工具调用与工具结果。
 *
 * ## 两类必须剔除的坏数据
 *
 * ① **配对缺口**：OpenAI 兼容协议要求带 `tool_calls` 的 assistant 消息，
 * 其**每一个** tool_call id 都必须紧跟一条对应的 `role:'tool'` 结果消息；
 * 反之 `role:'tool'` 消息也必须有对应的前置 tool_call。缺任一侧，后端都会以
 * 400 拒绝整个请求。工具执行失败时（参数非法、超时、工具不存在……）harness
 * 会把 assistant 的 tool_calls 持久化进会话历史，却写不回结果消息。
 *
 * ② **名称为空 / 缺失的 tool_call**（2026-09-23 定位，用户报障）：
 * 会话历史里出现 `{type:'tool-call', id:'call_…', name:'', arguments:'{}'}`
 * 时，workbuddy 以 **HTTP 400 `code 11133 model_param_invalid`** 拒绝整个请求
 * （错误文案只说"请求参数不符合当前模型要求"，**不指出是哪个字段**，极难排查）。
 * 实测最小复现（`scripts/confirm-empty-tool-name.ts`）：
 *
 * | wire 上 `function.name` | 结果 |
 * |---|---|
 * | `"read"` | 200 |
 * | `"unknown_tool"`（不存在的工具名） | 200 ← **只校验"非空"，不校验存在性** |
 * | `""` / `null` / 缺失 | **400 code 11133** |
 *
 * 与配对缺口的关键差异：**空名字即使配对完整也照样 400**，且报的是
 * 11133（参数非法）而非 11148（配对不匹配），两者成因完全独立。
 *
 * 来源是 qoder 的 SSE：模型偶发吐出一个**完全没有 name 字段**的 tool-call
 * 分片（实测 seq=693 的 `{index:2, id:'call_25e9…', args:[""]}`），
 * `consumeOpenAiSse` 在 block-end 处 `name: block.name ?? ''` 把它落成空串块，
 * harness 执行得到 `unknown tool ""` 并把这条坏块**持久化进会话**。
 * 此后用户一旦切换到 workbuddy（或任何腾讯系端点），该坏块被**每次请求原样重放**
 * → 会话彻底报废（表现为"一发消息就报参数错误，怎么重试都不行"）。
 *
 * 这条坏数据**跨 provider 传染**：qoder 产生、workbuddy 受害。故防线放在
 * 本共享函数（四个适配器都调用它），而不是某个适配器内部。
 *
 * ## 为什么由适配器兜底
 *
 * 坏块已在会话里，harness 不会自愈。适配器是最后一道防线：发出请求前剔除，
 * 宁可丢失一轮工具上下文，也好过整条会话死亡。
 *
 * @param messages - harness 会话消息（按时间顺序）。
 * @returns 应当保留的 tool_call id 与 tool 结果 id 集合。
 */
export function resolveToolPairing(
// `content` 可选：归一化层产出的 `HarnessMessageLike` 允许缺 content，
// 且该函数内部本就按「非数组即视为空」处理，放宽签名不改变行为。
messages) {
    // ⚠️ 先归一化 DSH 0.1.7 的消息形状：0.1.7 把工具结果改为一等 `role:'tool'`
    // 消息，不再有 `tool-result` 块。若不归一化，下面的 `allResultIds` 恒为空集，
    // `usable.every(block => allResultIds.has(...))` 恒 false → **assistant 的
    // 全部 tool_calls 被剔除**，模型在 wire 上看不到自己调用过什么，表现为
    // 「无工具调用即判对话结束」或「陷入循环思考」。详见 `message-shape.ts`。
    const normalized = normalizeHarnessMessages(messages);
    // 收集历史上出现过的所有工具结果 id（harness 把结果搭载在 user 消息里）。
    const allResultIds = new Set();
    for (const message of normalized) {
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
            if (typeof block === 'object' && block !== null && block.type === 'tool-result') {
                allResultIds.add(String(block.toolCallId));
            }
        }
    }
    // 一批 tool_calls 里，**名称可用**的那些才可能保留：名称为空的调用无论
    // 是否配对完整都会被上游 400（见上方表格）。同批其余调用不受影响 ——
    // 结果按 id 匹配，剔掉一个不会破坏另一个的配对。
    const keepCallIds = new Set();
    for (const message of normalized) {
        if (message.role !== 'assistant')
            continue;
        const content = Array.isArray(message.content) ? message.content : [];
        const calls = content.filter((block) => typeof block === 'object' && block !== null && block.type === 'tool-call');
        if (calls.length === 0)
            continue;
        const usable = calls.filter(block => hasUsableToolName(block.name));
        if (usable.length === 0)
            continue;
        // 一批里可用的那些只有**全部**拿到结果才能保留：部分保留会留下无结果的
        // tool_call，后端照样拒绝。
        if (usable.every(block => allResultIds.has(String(block.id)))) {
            for (const block of usable)
                keepCallIds.add(String(block.id));
        }
    }
    // 结果消息只有在对应 tool_call 被保留时才保留。
    const keepResultIds = new Set();
    for (const id of keepCallIds) {
        if (allResultIds.has(id))
            keepResultIds.add(id);
    }
    return { keepCallIds, keepResultIds };
}
export function normalizeToolArguments(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return '{}';
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        // 不完整的 JSON（流被截断）：回退为空对象。
        return '{}';
    }
    // OpenAI 规范要求 arguments 是对象；null / 数组 / 标量都不是合法参数包。
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return '{}';
    return trimmed;
}
/**
 * 判断工具参数是否因分片丢失而残缺（区别于"该工具本就无参数"）。
 *
 * 两种"不合法"必须区分对待：
 * - **空串**：无参数工具（如 `list_dir`）只下发一个空分片，这是**合法**的，
 *   补 `{}` 即可，工具照常执行；
 * - **非空但无法解析**：说明参数分片在流式下发中丢了。后端并行下发多个工具
 *   调用时偶发——实测 session-23851745 turn1 step4，模型并行发起两个 `read`，
 *   两个调用都丢了 `{"file_path": "…` 前缀，仅剩路径中段与尾部。
 *
 * 后者绝不能补成 `{}` 了事：那等于伪造一个"看起来合法"的调用，harness 执行
 * 时报 `missing required property "file_path"`，模型收到莫名其妙的参数错误，
 * 而真正的病因（分片丢失）被掩盖。正确做法是判定为截断，报告 max-tokens，
 * 让 dsh 丢弃残缺调用并重试——实测重试一次即恢复正常。
 *
 * 注意：只把**无法解析**视为截断。能解析但类型不对（标量、数组）属于模型
 * 输出有误，交给 schema 校验回传即可，不应触发重试。
 */
export function isTruncatedArguments(raw) {
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return false;
    try {
        JSON.parse(trimmed);
        return false;
    }
    catch {
        return true;
    }
}
/**
 * 归一化 `sliceChars`：非有限值（NaN / Infinity）回退默认值，并钳到 ≥1。
 *
 * ⚠️ **必须钳下限**：`observe` 用 `offset += sliceChars` 推进切片循环，
 * 步长为 0 或负数会让循环永不推进 → **同步死循环、进程挂死**。
 * 而同步死循环**无法被测试框架的超时打断**（超时由事件循环 timer 实现），
 * 表现为整个测试进程永久挂住且零诊断 —— 故这里必须兜住，不能只靠调用方自觉。
 *
 * `NaN` 也必须兜：`Math.max(1, NaN)` 仍是 `NaN`，会让 `offset < delta.length`
 * 恒为 false → 判据**静默失效**（fail-open，不检测任何循环）。
 */
export function resolveSliceChars(raw) {
    const value = raw ?? 64;
    return Number.isFinite(value) ? Math.max(1, value) : 64;
}
/**
 * 创建思考死循环检测器。
 *
 * ## 真实缺陷（用户报障，2026-09-23）
 *
 * `workbuddy/deepseek-v4.1-flash` 报「已达到输出 token 上限，回答被截断」。
 * 排查确认**不是**参数沿用上一个模型（DSH 按当前模型解析 `maxTokens`；
 * 且同一会话 turn 1 未做任何切换就爆额度），而是模型思考陷入病态重复：
 *
 * ```
 * Let me write. / Writing. / Go. / OK. / Producing. / Let me output. / Final.
 * ```
 *
 * `reasoning_tokens` **计入** `completion_tokens`，故思考停不下来 = 正文零产出，
 * 最终 `reasoningTokens == outputTokens == 128000`、`finish_reason: length`。
 * 该模型只声明 `reasoningEfforts: ['high']`（仅一档），用户无法靠降档缓解。
 *
 * ## 判据为什么是这两个（实测依据）
 *
 * 评估了三种判据（正常 109 条 / 死循环 6 条真实样本）：
 *
 * | 判据 | 正常误报 | 死循环命中 |
 * |---|---|---|
 * | n-gram 重复占比 | 0/109 | 2/3 |
 * | **窗口去重行比例 + 持续体量** | **0/109** | **3/3** |
 * | 尾部行周期 | 0/109 | 1/3 |
 *
 * 故取第二种。**「持续体量」这一层不可省**：实测 seq=401 在 14848/15795
 * （94%）处被判局部循环，但它随即自愈并产出了工具调用 —— 它的持续体量
 * 仅 1024 字符，被 `minLoopChars=2000` 正确排除；而三个真死循环的持续体量
 * 是 435,968 ~ 509,184。区分度极高。
 *
 * 正常样本窗口去重率最低 0.149、死循环 0.017~0.031，**5 倍余量**。
 *
 * ⚠️ 只应喂 **reasoning** 增量：正文里的重复（代码块、列表）是正常输出。
 */
export function createReasoningLoopDetector(options = {}) {
    const windowChars = options.windowChars ?? 3000;
    const maxDistinctLineRatio = options.maxDistinctLineRatio ?? 0.35;
    const minLines = options.minLines ?? 40;
    const minLoopChars = options.minLoopChars ?? 2000;
    /**
     * 内部切片大小（字符）。
     *
     * 它使**触发结论**与 `cutAt > 0` 与调用方粒度无关，但**不**保证 `cutAt`
     * 数值与粒度无关 —— 数值精度受切片大小限制（调用方粒度小于切片大小时更
     * 精确：实测粒度 3 → 1614、10 → 1610、≥64 → 1600），触发时机也会随 delta
     * 边界推迟。实测 64 与 256 都能满足全部约束；取 64 以获得更精确的截断点
     * （死循环样本 cutAt=1600 vs 1536）。
     *
     * ⚠️ **<1 会被钳到 1**（`NaN` / `Infinity` 回退 64）：未钳制时
     * `observe` 的 `offset += sliceChars` 永不推进 → **死循环、进程挂死**。
     * 其余数值选项（如 `windowChars: 0`）都不会造成这种失败模式。
     * 归一化逻辑单列在 {@link resolveSliceChars}，便于纯函数断言。
     */
    const sliceChars = resolveSliceChars(options.sliceChars);
    let text = '';
    let detected = false;
    let cutAt;
    /** 当前连续循环段的起点（字符偏移）与已持续长度。 */
    let runStart = 0;
    let runChars = 0;
    /**
     * 喂入一个**固定小片**并推进状态机。
     *
     * ⚠️ 判据的「持续体量」必须按**内部切片**累加，不能按调用方给的 delta 累加。
     * 旧实现 `runChars += delta.length` 直接采用调用方边界，于是单个 delta 大于
     * `minLoopChars` 时一次观察即满足阈值、`runStart` 落在该 delta 开头 →
     * `cutAt = 0` → **把回答截成空**；更糟的是会误伤「早期自愈」负样本
     * （它正是「零误报」结论的关键）。实测粒度 3000 时自愈样本被误触发。
     *
     * 真实流式帧极小（实测 1379 万帧：p99=10、max=95 字符），故逐帧调用的适配器
     * 不可达；但 `llm-adapter.ts`（codearts）是累积后一次性调用 → **真实可达**。
     *
     * ⚠️ **`cutAt === 0` 在默认参数下不可达、调参可复现**（等价说法：默认参数下
     * `cutAt > 0` 必然成立）。它依赖 `minLines` 与 `sliceChars` 的大小关系
     * （下述论证**不依赖调用方粒度**）：进入 looping 至少需 `minLines=40`
     * 个非空行。`n` 个非空行**至少**占 `2n−1` 字符（每行 ≥1 字符，行间 1 个换行），
     * 代入 `n ≥ 40` 得**至少 79 字符**；而任一片的长度恒 `≤ sliceChars`(64) < 79
     * ⇒ **首片结束时不可能已满足 40 行** ⇒ `runStart` 最早只能落在**第二片开头**，
     * 即 `runStart ≥ 首片长度 ≥ 1` ⇒ **`cutAt > 0`**。
     *
     * 若调用方**调大 `sliceChars`** 使单片即可容纳 ≥79 字符（即 ≥40 个非空行），
     * 或**下调 `minLines`**（两者都是既有可调项），首片即可能直接命中、
     * `runStart = 0` → **`cutAt = 0` 截空复现**。
     *
     * **实测（40 个非空行的重复体，单元 79 字符）**：`sliceChars=32` → `cutAt=64`、
     * `64` → `64`（默认参数，安全）；**`sliceChars=128` → `cutAt=0`**（截空）、
     * `256` → `0`。即约束的临界正在「单片 ≥79 字符」处，`128` 已越过它。
     * 调参时必须重新核验该约束。
     */
    function feedPiece(piece) {
        text += piece;
        // 只看尾部窗口：循环是「局部持续」现象，不必回溯全文。
        const window = text.slice(Math.max(0, text.length - windowChars));
        const lines = window.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        const looping = lines.length >= minLines
            && new Set(lines).size / lines.length < maxDistinctLineRatio;
        if (!looping) {
            // 恢复正常：清零持续计数，使「循环→正常→再循环」只认后一段。
            runStart = 0;
            runChars = 0;
            return false;
        }
        if (runChars === 0)
            runStart = text.length - piece.length;
        runChars += piece.length;
        if (runChars < minLoopChars)
            return false;
        detected = true;
        cutAt = runStart;
        return true;
    }
    return {
        get detected() { return detected; },
        get cutAt() { return cutAt; },
        observe(delta) {
            if (detected)
                return false;
            if (delta.length === 0)
                return false;
            // 把任意粒度的 delta 切成固定小片，使结论只取决于切片大小而非调用方边界。
            for (let offset = 0; offset < delta.length; offset += sliceChars) {
                if (feedPiece(delta.slice(offset, offset + sliceChars)))
                    return true;
            }
            return false;
        },
    };
}
/**
 * 解析 `DSH_REASONING_LOOP_GUARD`；**默认开启**。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭。与 `isTruthyFlag`
 * 的「默认关」语义相反（对齐 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` /
 * `DSH_TRAE_MAX_MODE`），故单列一个函数，**不要混用**。
 */
export function resolveReasoningLoopGuardFlag(raw) {
    if (raw === undefined)
        return true;
    const value = raw.trim().toLowerCase();
    return !(value === '0' || value === 'false' || value === 'no' || value === 'off');
}
/** 思考死循环检测是否启用（读环境变量）。 */
export function isReasoningLoopGuardEnabled() {
    return resolveReasoningLoopGuardFlag(process.env.DSH_REASONING_LOOP_GUARD);
}
/**
 * `</think:hex>` 闭标签的匹配式（**区分大小写、hex 至少 1 位**）。
 *
 * 刻意不做大小写兼容：实测 28 处标签**恒为小写**，放宽只会扩大误伤面
 * （`</THINK:…>` 从未出现过）。
 */
const THINK_CLOSE_TAG_RE = /<\/think:([0-9a-f]+)>/g;
/**
 * 按 `</think:hex>` **闭标签**把正文拆成「思考 + 真正文」。
 *
 * ## 真实缺陷（用户报障，2026-09-25）
 *
 * `workbuddy/hy4-preview-f` 把**思考**写进 `content`（正文）通道，只在思考段
 * 末尾留一个 `</think:6124c78e>` 闭标签。实测该会话 93 步里只有 9 步的
 * reasoning 通道非空 —— 思考总量 9563 字符，而正文 64043 字符。
 *
 * 两个后果：
 *  1. 思考落在正文块里 → 思考死循环守卫（只喂 reasoning 增量）**完全看不见**
 *     → 该模型正文出现真循环（去重率 0.0412），实测三段
 *     （seq 34752 / 34768 / 34823，最长 34406 字符）；
 *  2. 用户界面上看到「模型把内心独白当正文输出」。
 *
 * ## 实测形态（155 会话全量普查）
 *
 * | 项 | 值 |
 * |---|---|
 * | 含标签的步数 | 28（仅 2 个模型：`hy4-preview-f` 25、`workbuddy/deepseek-v4.1-flash` 3）|
 * | **开标签** | **0** |
 * | 闭标签 | 28（每步恰好 1 个）|
 * | hex | 恒为 `6124c78e`（会话级 id）|
 * | 标签前 | 内心独白（`让me check.` 重复），13~34364 字符 |
 * | 标签后 | **真正文**，13~56 字符 |
 *
 * ## 三个刻意的设计取舍
 *
 * 1. ⚠️ **以最后一个闭标签为界**，且**剔除思考段里的全部标签**：实测每步只有
 *    一个标签，但多标签时「以最后一个为界」才能保证正文完整 —— 若以第一个
 *    为界，第二个标签会留在正文里。
 * 2. ⚠️ **只认闭标签、不猜开标签**：实测开标签**恒缺失**。仅见开标签时无法
 *    确定「思考到哪结束」，**不切分**（保持原样）比猜错安全。
 * 3. ⚠️ **无标签时返回 `undefined`**（而非空切分结果）：调用方据此走原路径，
 *    保证 99.6% 的普通响应**逐字节不受影响**。
 *
 * @returns 命中时返回切分结果；无闭标签时返回 `undefined`。
 */
export function splitThinkTaggedContent(raw) {
    if (raw.length === 0)
        return undefined;
    // ⚠️ 正则**在函数内新建**：带 `g` 的正则对象有 `lastIndex` 状态，复用一个
    // 模块级实例会让相邻两次调用互相干扰（第二次从上次的位置开始搜）。
    const re = new RegExp(THINK_CLOSE_TAG_RE.source, 'g');
    let last;
    for (let m = re.exec(raw); m !== null; m = re.exec(raw))
        last = m;
    if (last === undefined)
        return undefined;
    // ⚠️ **引用判据（不可省）**：标签可能只是被模型**讨论/复述**，而非泄漏分界。
    // 实测 28 处 text 块标签里有 **3 处是反引号包裹的行内引用** —— 包括排查
    // 本缺陷时会话里复述该标签字面量的正常正文。若只看「有没有标签」，会把
    // 这类正文的前半段误当思考移走。
    //
    // 实测该判据分离度 **3/3 与 25/25 全部正确**：反引号包裹 ⇔ 引用。
    if (isQuotedThinkTag(raw, last.index))
        return undefined;
    const boundary = last.index;
    const textStart = boundary + last[0].length;
    // 思考段里可能还残留更早的标签，一并剔除（否则会把标签当思考内容展示）。
    const reasoning = raw.slice(0, boundary).replace(new RegExp(THINK_CLOSE_TAG_RE.source, 'g'), '');
    return { reasoning, text: raw.slice(textStart), textStart };
}
/**
 * 判断 `index` 处的标签是否处于**引用语境**（反引号 / 代码块），而非真泄漏。
 *
 * ## 为什么必须有这条判据（实测依据）
 *
 * 普查 155 会话的全部 `text` 块标签（28 处），发现两类形态：
 *
 * | 形态 | 处数 | 标签前一非空字符 | 含义 |
 * |---|---|---|---|
 * | **行内引用** | 3 | 反引号 `` ` `` | 模型在讨论/复述该标签 |
 * | **真泄漏** | 25 | `.` / `。`（句子结尾）| 思考与正文的分界 |
 *
 * 判据「标签是否被反引号包裹」的分离度是 **3/3 与 25/25**，零交叉。
 *
 * ⚠️ 3 处引用里包含**排查本缺陷时我自己输出的正文**（复述 `</think:6124c78e>`
 * 这个字面量）—— 这正是「只看有没有标签会误伤」的直接证据。
 *
 * 两种语境都认：
 * - **行内代码**：紧邻标签的字符是反引号（`` `</think:hex>` ``）；
 * - **围栏代码块**：标签之前存在**未闭合**的 ``` 围栏（奇偶计数）。
 *
 * 只做廉价判定，不做完整 Markdown 解析 —— 判据只需覆盖实测形态。
 */
function isQuotedThinkTag(raw, index) {
    // ① 行内代码：标签紧邻的字符是反引号。
    const before = raw.slice(0, index).trimEnd();
    if (before.endsWith('`'))
        return true;
    const after = raw.slice(index).trimStart();
    // 标签自身长度 + 可能的 hex；这里只需看标签**之后**是否紧跟反引号。
    const tagEnd = raw.indexOf('>', index);
    if (tagEnd !== -1 && raw.slice(tagEnd + 1).trimStart().startsWith('`'))
        return true;
    // ② 围栏代码块：标签之前有**奇数个** ``` 围栏（即处于未闭合的代码块内）。
    const fences = raw.slice(0, index).match(/```/g);
    return fences !== null && fences.length % 2 === 1;
}
/**
 * ASCII 字母（仅用于「`course` 后接字母则不删」的保护面判定）。
 *
 * ⚠️ 刻意用**单字符**正则而非 `/^[A-Za-z]/`：`test()` 对带 `^` 的正则每次调用
 * 都要从头匹配，且这里逐行调用、数据量大。单字符字符类语义完全等价。
 */
const ASCII_LETTER_RE = /[A-Za-z]/;
/**
 * 清洗**行首**的 `course` / `课` 泄漏 token。
 *
 * ## 真实缺陷（用户报障，2026-09-23）
 *
 * 用户观察：`deepseek-v4.1-flash` 的输出与思考中，**经常一行开头带一个中文「课」
 * 或英文「course」**，会污染提示词。
 *
 * ## 实测形态（全库核实：295 会话 / 307 万行）
 *
 * | 事实 | 数据 |
 * |---|---|
 * | `course` 片段长度 | **1381/1381 全部恰好 6 字符**，全文即 `"course"` |
 * | `课` 片段长度 | **3362/3366 恰好 1 字符**，全文即 `"课"` |
 * | 位置分布 | 行首 **2347**、行中 28（后者全是我们分析此现象的会话文字） |
 * | 前接上下文 | 只有 `\n\n`(2395) / 块首(261) / `\n`(69) 三种，**无例外** |
 *
 * 100% 规整 → **不是**模型生成的自然语言，而是某个「段落起始」类**特殊 token
 * 被解码成了字面量**（中文侧 `课`、英文侧 `course`，同源 —— 都是 "course" 的字面义）。
 *
 * 用户的补充（已证实）：「`课查` / `课修` 都是泄漏，只不过是**泄漏 + 模型循环**
 * 两个问题叠加」—— 泄漏 token 后面直接跟模型正文/循环短句（`课查。` 895 次、
 * `课跑。` 308、`课修。` 307…）。这也解释了为何量极大：模型进入循环后每轮迭代
 * 都带一个泄漏前缀。
 *
 * ## 为什么判据是「行首一律删」，而不是白名单
 *
 * 泄漏就是**单个 `课` 字**，后面接任意正文 —— 故「`课` + 某字」永远可能是
 * 「泄漏 + 正文」的偶然组合，**任何白名单都会被绕过**。实测反证：
 *
 * | 曾以为要保护的词 | 数据真相 |
 * |---|---|
 * | `课改`(12) | 行首 **10 次全是泄漏**（`课改测试。`、`课改 handler.go。`） |
 * | `课时`(3) | 行首 3 次全是泄漏（`课时间轴逻辑…`） |
 * | `课程`(23) | **全在中部**，且全是分析此现象的会话文字，非模型输出 |
 *
 * 故判据为：
 *
 * ```
 * 行首（块首 或 前一字符是 \n，允许前置空白）的 `course`
 *   且后接 ∉ {ASCII 字母}                      → 删掉 `course`
 * 行首（同上）的 `课`                            → 删掉 `课`
 * ```
 *
 * `course` 唯一保留的保护面是**后接 ASCII 字母时不删**：避免误删 `courseware` /
 * `coursework` 这类真实英文词。
 *
 * ⚠️ **判据曾在 2026-09-23 定得过窄，2026-09-25 修正** —— 初版要求后接**空白**
 * （` ` / `\t` / `\r` / 行尾），依据是当时实测「行首 `course` 后接非空白出现 0 次」。
 * 该实测**是错的**：在 lilishop-go 的 `session-d0ec32df` 里实测出 75 处行首
 * `course`，后接字符为 `注`(14) `关`(14) `这`(7) `核`(5) `，`(4) `先`(3) …，
 * **75/75 全部后接中文、无一处后接空白**，故初版判据命中率 **0%**（全部漏放）。
 * 用户报障「偶尔还是有泄露」即此 —— 且构建之后仍在复现（实测 10 处），
 * 不是旧产物问题。
 *
 * 根因：`course` 泄漏在中文语境里**后面直接接中文**（无空格），而初版按
 * 「英文词后面该有空格」设计，恰好把真实语境整个排除。放宽后对上述 75 处
 * 命中 **100%**、误删 **0**。
 *
 * 实测效果：初版命中 **2346** 处、行首未命中 **0** 处；中部 28 处（真正的正常用法
 * `研讨课` / `重要的一课` / `of course` / `recourse`）**完全不受影响**。
 *
 * ⚠️ **已知边界（非零风险，故必须带开关）**：若模型真的以「课程设计已完成。」
 * 这样的句子开头，会变成「程设计已完成。」。实测 0/2346，但原理上非零 ——
 * 因为泄漏后接的正文可能偶然拼成正常词。可用 `DSH_COURSE_LEAK_STRIP=0` 关闭。
 *
 * ⚠️ **不解析 markdown 围栏**：围栏内若出现行首 `course` 同样会被删。实测数据里
 * 泄漏都出现在自然语言段落、围栏内无此形态，故接受该简化。
 *
 * @param text - 待清洗文本（reasoning 块或 text 块）。
 * @returns 清洗后的文本；无泄漏时**原样返回同一字符串**。
 */
export function stripCourseLeak(text) {
    if (text.length === 0)
        return text;
    // 快速短路：绝大多数文本不含目标词，避免无谓的逐行处理。
    if (!text.includes('course') && !text.includes('课'))
        return text;
    const lines = text.split('\n');
    let changed = false;
    const cleaned = lines.map((line) => {
        // 行首 = 允许前置空白后的第一个字符（实测泄漏无缩进，但为稳妥仍处理）。
        const match = /^([ \t]*)(course|课)(.*)$/.exec(line);
        if (match === null)
            return line;
        const [, indent, word, rest] = match;
        if (word === 'course') {
            // ⚠️ 判据是「后接**不是 ASCII 字母**」即视为泄漏 —— **不是**「后接空白」。
            //
            // 初版要求后接空白（` ` / `\t` / `\r` / 行尾），依据是当时实测「行首 `course`
            // 后接非空白出现 0 次」。**该实测是错的**：2026-09-25 在 lilishop-go 的
            // `session-d0ec32df` 里实测出 75 处行首 `course`，后接字符分布为
            // `注`(14) `关`(14) `这`(7) `核`(5) `，`(4) `先`(3) `我`(3) … ——
            // **75/75 全部后接中文，无一处后接空白**，于是初版判据把它们**全部放过**
            // （命中率 0%）。形态如 `course，我需要区分…` / `course实现。` / `course核实。`。
            //
            // 根因：`course` 泄漏在中文语境里后面**直接接中文**（无空格），而初版按
            // 「英文词后面该有空格」设计保守判据，恰好把真实语境整个排除。
            //
            // 现判据只保留一个保护面：**后接 ASCII 字母时不动**（`courseware` /
            // `coursework` 这类真实英文词）。实测对上述 75 处放宽后命中 100%、
            // 误删 0。非 ASCII 后接（中文标点、汉字、行尾、空白）一律判为泄漏。
            const first = rest[0];
            if (first !== undefined && ASCII_LETTER_RE.test(first))
                return line;
            // 连同其后一个空格一起删，避免留下行首空格。
            const trimmed = rest.startsWith(' ') ? rest.slice(1) : rest;
            changed = true;
            return indent + trimmed;
        }
        // `课`：行首一律删（实测行首 `课` 100% 是泄漏）。
        const trimmed = rest.startsWith(' ') ? rest.slice(1) : rest;
        changed = true;
        return indent + trimmed;
    });
    return changed ? cleaned.join('\n') : text;
}
/**
 * 解析 `DSH_COURSE_LEAK_STRIP`；**默认开启**。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭。与 `isTruthyFlag`
 * 的「默认关」语义相反（对齐 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` /
 * `DSH_REASONING_LOOP_GUARD`），故单列一个函数，**不要混用**。
 *
 * ⚠️ 提供开关是因为判据有**已知边界**：若模型真的以「课程设计…」开头，
 * 「课」会被误删。实测 0/2346，但原理上非零。
 */
export function resolveCourseLeakStripFlag(raw) {
    if (raw === undefined)
        return true;
    const value = raw.trim().toLowerCase();
    return !(value === '0' || value === 'false' || value === 'no' || value === 'off');
}
/** 行首泄漏清洗是否启用（读环境变量）。 */
export function isCourseLeakStripEnabled() {
    return resolveCourseLeakStripFlag(process.env.DSH_COURSE_LEAK_STRIP);
}
/**
 * 按开关决定是否清洗；**供适配器的 `block-end` 收尾处调用**。
 *
 * 清洗放在**组装后**（而非流式增量）有两个理由：
 * 1. 判据需要「行首」这个上下文，而增量里 `course` 可能跨 chunk 到达
 *    （`cou` + `rse`），流式层无法判定；
 * 2. 只改 `block-end` 的 `block.text` 不必引入缓冲，不影响首 token 延迟。
 *
 * 实测 `BlockAssembler` 的 `block-end` 是**权威覆盖**，故此处改文本即可生效
 * （与死循环截断同一机制）。
 */
export function stripCourseLeakIfEnabled(text) {
    return isCourseLeakStripEnabled() ? stripCourseLeak(text) : text;
}
/**
 * 清洗**历史消息**里已持久化的行首泄漏；**供各适配器的序列化前调用**。
 *
 * ## 为什么还需要这一层（`block-end` 清洗不够）
 *
 * `block-end` 清洗只管**本次新生成**的文本。但泄漏早在本次修复之前就已
 * **持久化进会话历史**（实测全库 2771 行），此后每轮请求都会把这段脏历史
 * 原样重放给模型 —— 正是用户报障的「污染提示词」。
 *
 * 故必须在**发给模型之前**再清一道，让**存量坏会话自愈**、无需用户重开会话。
 * 这与「名称为空的 tool_call」那次的思路一致（消费侧修源头 + 序列化侧治存量）。
 *
 * ## 只清 assistant，不碰 user / system / tool 结果
 *
 * ⚠️ **判据只对模型自己的输出成立**（泄漏 token 由模型产生）。
 * 用户消息是**人的输入** —— 里面出现的「课」/「course」可能是用户真的在
 * 讨论这个词（本次排查期间我自己的分析文字就大量含 `课查。`）。
 * 清洗用户输入会**篡改用户的话**，绝不可为。
 *
 * 故：
 * - `role === 'assistant'` 的 `text` / `reasoning` 块 → 清洗；
 * - `tool-call` 的 `arguments` → **不清洗**（是 JSON，改了会破坏解析）；
 * - 其余角色的所有内容 → **不清洗**。
 *
 * @param message - 一条 harness 原生消息。
 * @returns 清洗后的 content 数组；无改动时返回**原数组**（保持引用相等）。
 */
export function stripCourseLeakFromHistoryContent(role, content) {
    if (role !== 'assistant')
        return content;
    if (!isCourseLeakStripEnabled())
        return content;
    let changed = false;
    const cleaned = content.map((raw) => {
        if (typeof raw !== 'object' || raw === null)
            return raw;
        const block = raw;
        // 只动 text / reasoning 两种纯文本块。
        if (block.type !== 'text' && block.type !== 'reasoning')
            return raw;
        if (typeof block.text !== 'string' || block.text.length === 0)
            return raw;
        const stripped = stripCourseLeak(block.text);
        if (stripped === block.text)
            return raw;
        changed = true;
        return { ...block, text: stripped };
    });
    return changed ? cleaned : content;
}
//# sourceMappingURL=sse.js.map