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
 *
 * ⚠️ `name is string` 这个类型谓词是**纯编译期**的收窄（运行期行为逐字节不变），
 * 它让调用方在判过之后可以直接使用 `name` 而无需再断言 —— 网关侧因此不必写
 * `String(...)` 或 `!`，那两种写法都会把「判据」与「取值」拆成两份、进而漂移。
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
 * Unicode `Cf`（格式字符：零宽空格 `U+200B`、零宽连字 `U+200C`、BOM 之外的各种
 * 「看不见但存在」的码点）。
 *
 * ## 为什么必须单独剥（对抗审计实测的误判方向）
 *
 * `String.prototype.trim()` **只剥空白类**，`U+200B` 这类 `Cf` 它不碰。于是
 * `\u200b{"a":1}` —— 一个**模型写对了、传输/编码环节混入零宽字符**的样本 ——
 * 会 `JSON.parse` 失败且末字符是 `}` ⇒ 被判 `invalid` ⇒「**模型把参数写坏了**」。
 * 这是**归因错**：模型的输出没问题，错的是不可见字符。处置方向也随之错
 * （`invalid` 建议换模型，而真正该做的是重试）。
 *
 * ⚠️ 与 `protocol-wire.md` 记录的网关通配判据同一条纪律：**不可见字符必须按
 * Unicode 类别处理，不能枚举码点**（`Cf` 有 160+ 个，枚举必漏）。
 *
 * ⚠️ 只用于**判定**，绝不用于产出：本函数返回的文本不进 `block-end`，落盘参数
 * 仍是原文（改写输出会让工具真的收到被改过的参数）。
 */
const INVISIBLE_FORMAT_RE = /[\p{Cf}]/gu;
/**
 * **完整**但非法的 JSON 字面量（模型写的就是这个词，不是被掐断）。
 *
 * `NaN` / `Infinity` / `-Infinity` / `undefined` 都是「写法完整、语义非法」——
 * 末字符不是 `}` / `]`，会撞上下面的「末字符腿」被判 `truncated`，
 * 但它们的结构是**完整**的：模型把参数写成了 `NaN`，重试大概率原样复现。
 * ⇒ 归 `invalid` 才自洽（对抗审计实测：裸 `NaN` 曾被判 `truncated`）。
 */
const COMPLETE_INVALID_LITERAL_RE = /^(?:NaN|-?Infinity|undefined)$/;
export function classifyToolArguments(raw) {
    const trimmed = raw.trim();
    // ① 空串 ⇒ 无参数工具（`list_dir` 这类只下发一个空分片），合法。
    if (trimmed.length === 0)
        return 'ok';
    try {
        JSON.parse(trimmed);
        return 'ok';
    }
    catch {
        // 继续判定「是掐断还是写坏」。
    }
    // ①·5 完整的非法字面量（见 `COMPLETE_INVALID_LITERAL_RE`）。
    if (COMPLETE_INVALID_LITERAL_RE.test(trimmed))
        return 'invalid';
    // ①·6 **不可见字符污染**：原文 parse 失败，剥掉 `Cf` 后能 parse ⇒ 模型的 JSON
    // 本身是对的，错在混入了零宽字符 ⇒ 判 `truncated`（重试，**不**给模型定罪）。
    //
    // ⚠️ 必须先试原文（上面第 ① 步已做），否则「含合法 ZWJ 序列的正常 JSON」
    // 会被误判成污染。剥后仍 parse 失败 ⇒ 继续走下面的结构判定。
    //
    // ⚠️ **不得**用带 `g` 标志的 `INVISIBLE_FORMAT_RE.test()` 做探测：`g` 正则的
    // `lastIndex` 会跨调用残留，同一函数内连测两次会得到**交替**的 true/false
    // （这是 JS 里最经典的假守卫来源之一）。故这里用一次 `replace` 的返回值判断
    // 有没有变化，不碰 `test()`。
    const visible = trimmed.replace(INVISIBLE_FORMAT_RE, '');
    if (visible !== trimmed) {
        try {
            JSON.parse(visible);
            return 'truncated';
        }
        catch {
            // 剥了也 parse 不了：污染不是唯一问题，按结构继续判。
        }
    }
    // ② 连收尾括号都没有 ⇒ 必然被掐断（模型写坏时通常仍会写完整个 `}`）。
    const last = trimmed[trimmed.length - 1];
    if (last !== '}' && last !== ']')
        return 'truncated';
    // ③ 跳过字符串字面量统计嵌套深度。
    //
    // ⚠️ 转义处理必须**先判 `\`**：`"\""` 里的 `\"` 不能让引号翻转状态，
    // 否则后半段全部被当成「在字符串里」而漏掉括号。`\\` 同理（一个转义的反斜杠
    // 后面那个 `\` 不再开启转义）。
    let braces = 0;
    let brackets = 0;
    let inString = false;
    let escaped = false;
    for (const ch of trimmed) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (ch === '{')
            braces += 1;
        else if (ch === '}') {
            braces -= 1;
            // 深度转负 ⇒ 前面缺了开括号（分片丢失的典型形态）⇒ 掐断。
            if (braces < 0)
                return 'truncated';
        }
        else if (ch === '[')
            brackets += 1;
        else if (ch === ']') {
            brackets -= 1;
            if (brackets < 0)
                return 'truncated';
        }
    }
    if (braces !== 0 || brackets !== 0)
        return 'truncated';
    // 收尾了却仍在字符串里（引号奇数）⇒ 无法区分「写坏」与「截在字符串中间」
    // ⇒ fail-safe 判 truncated。
    if (inString)
        return 'truncated';
    // ④ 闭合、配平、引号成对，却仍 parse 失败 ⇒ 模型语法写坏了。
    return 'invalid';
}
/**
 * 「工具参数不是合法 JSON」的**错误码**。
 *
 * ## 为什么不复用 `max-tokens`（真实缺陷，Gitee IKQ8Y1）
 *
 * DSH 客户端对 `max-tokens` 只有一句**固定 i18n**（`dsh-client-ui-chat` 的
 * `message.maxTokens` / `.hint`：**「已达到输出 token 上限 / 回答被截断…
 * 发送"继续"可让模型接着输出」**），**不读适配器的任何 message** ⇒
 * 真正的病因被吞掉，用户被引向「额度用满」这条错误处置（去查账号、等额度、
 * 降思考档、怀疑渠道），而这些**都不会好**。实测受害轮次
 * `usage.outputTokens = 2516`（上限 128000）—— 额度远没用满。
 *
 * 这与本仓库既有结论同族：`AUTH` 吞 message（IKLBSH）、思考死循环曾复用
 * `max-tokens`（已改为 {@link REASONING_LOOP_CODE}）。本条是同一家族的第三个成员。
 *
 * ## 为什么必须**不可重试**
 *
 * 与 {@link REASONING_LOOP_CODE} 同一条纪律：它**不在** harness 的
 * `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` /
 * `TIMEOUT` / `TRANSPORT`）里。白退避 5 次只会再烧一轮额度，而模型这一次的
 * 输出形态**大概率原样复现**（同一个工具、同一个坏字符位，实测两例都是第 13 字符）。
 *
 * ⚠️ 也不能取 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA`：客户端会替换文案（见
 * {@link REASONING_LOOP_CODE} 的同一段注释）。
 */
export const TOOL_ARGS_INVALID_CODE = 'TOOL_ARGS_INVALID';
/**
 * 判断工具参数是否是**可执行**的参数包（不只是「能 `JSON.parse`」）。
 *
 * ## ⚠️⚠️ 为什么不能用 `classifyToolArguments(...) === 'ok'`（对抗审计实测的真缺陷）
 *
 * `classifyToolArguments` 回答的是「这段字节是不是合法 JSON」，而
 * `ok` 里**包含 JSON 标量**：`123` / `"abc"` / `null` / `true` / `[]` / `[1,2]`
 * 全部返回 `ok`（它们确实是合法 JSON）。但接入点拿 `=== 'ok'` 判「**另一个可用
 * 调用**」——一个参数为 `123` 的调用并不是可用调用，于是：
 *
 * | 观测（真实适配器） | 结果 |
 * |---|---|
 * | 参数为 `123` / `null` / `"abc"` / `[1,2]` 的单调用 | `tool-calls` |
 * | **坏块 + 参数为 `123` 的另一调用** | `max-tokens`（本该 `TOOL_ARGS_INVALID`） |
 *
 * ## 为什么后果仍是「issue 要根除的那类症状」
 *
 * `normalizeToolArguments` 会把标量/数组兜底成 `{}`（见该函数注释），故 harness
 * **不会**真的执行参数为 `123` 的调用；它拿到的是 `arguments:"{}"` ⇒ 报
 * `missing required property` ⇒ 模型收到莫名其妙的参数错误后重试。
 * 也就是说：**症状没消失，只是换了条出口**，且我们失去了「模型把参数写坏了」
 * 这个有分辨力的归因。
 *
 * ## 判据与落盘口径**同源**
 *
 * 这里解析后按「是不是**非空对象**」判，而不是拿 `normalizeToolArguments` 的
 * 产物与字面量 `'{}'` 比：
 *
 * ⚠️⚠️ **第一版正是 `normalizeToolArguments(raw) !== '{}'`，那是比错对象**
 * （对抗审计实测的 P1）：`normalizeToolArguments` 对合法对象返回的是
 * **trim 后的原文**（见该函数 `return trimmed` 那一支）⇒
 *
 * | 输入 | 解析后语义 | 第一版判定 |
 * |---|---|---|
 * | `'{}'` | 空对象（无参工具的常见形态） | **不可用** ← 错 |
 * | `' {} '` | 空对象 | **不可用** ← 错 |
 * | `'{ }'` | 空对象 | 可用 |
 *
 * `'{}'` 与 `'{ }'` 语义**完全相同**、结论相反 ⇒ 自证是比错对象而非取舍。
 *
 * 端到端后果：坏块 + 一个参数为 `'{}'` 的合法无参调用 ⇒ 四家全部报
 * **`TOOL_ARGS_INVALID`**（不在 harness 可重试集合 ⇒ 硬失败），而本该报
 * `max-tokens`（保住那个可用调用）。`'{}'` 是无参工具最常见的形态，
 * 触发面不小 —— 故定 P1 而非 P2。
 *
 * ⚠️ 「空串」单独放行：无参工具也可能只下发一个空分片，那在本仓库语义里
 * **是**可用的。
 *
 * ⚠️ 本函数**只用于**「是否还有另一个可用调用」这条门禁，**不用于**判断
 * 「要不要报 `TOOL_ARGS_INVALID`」——后者看 `classifyToolArguments === 'invalid'`。
 * 两者是不同的问题，别合并。
 *
 * @param raw - 累积后的工具参数原文。
 */
export function isUsableToolArguments(raw) {
    if (raw.trim().length === 0)
        return true;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        // 解析不了 ⇒ 不可用（调用方另有 classifyToolArguments 管「坏」的归类）。
        return false;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return false;
    // 空对象（`{}` / `{ }` / `{"":""}` 之外的一切）都算可用 —— 只要工具自己
    // 能接受空参数包即可；harness 的 schema 校验会拦「缺必填字段」。
    return true;
}
/**
 * 「工具参数写坏」是否构成本步的**唯一产出**（决定报 `error` 还是退回 `max-tokens`）。
 *
 * ## ⚠️ 为什么必须抽成**一份**实现（本仓库首条红线）
 *
 * 四个适配器（`buddy-adapter` / `openai-compat` / `trae-adapter` /
 * `lobsterai-adapter`）都要判这同一件事。第一版在四处各写了一遍**逐字相同**的
 * 三条件表达式 —— 那正是「同一语义 N 套实现必然漂移」的形态：将来只要有一处
 * 被单独改动（例如某家把 `emittedProse` 换成别的变量、或漏掉
 * `hasUsableToolName` 腿），症状是**只有那一家**的处置悄悄变了，且四家的用例
 * 各自都是绿的。
 *
 * ## 三条门禁（缺一不可）
 *
 * 1. **至少一个块被判 `invalid`**（`classifyToolArguments` 的结论，调用方算好传入）；
 * 2. **零正文** —— `error` 路径**不落 `assistant/message`**（实测 219 会话里
 *    222 例），有正文时报 `error` 会把用户可见内容整块丢掉，只能退回 `max-tokens`
 *    保住内容；
 * 3. **没有另一个参数可解析的可用调用** —— 有的话照常报 `tool-calls` 让它执行，
 *    没理由因一个坏块把可用的那些一起作废（实测线上形态正是「一个无名 + 一个
 *    合法 pwsh」）。
 *
 * ## ⚠️⚠️ 另外两条「不得抢格」的排除（对抗审计实测的真回归，2026-10-25 修）
 *
 * 这两条**不是**可选的洁癖，是语义错位 —— 两者都由上层变量传入，因为它们
 * 各家的取值来源不同（`finishReason` / 是否收到 `[DONE]`）。
 *
 * | 格子 | 为什么不得报 `TOOL_ARGS_INVALID` |
 * |---|---|
 * | `finishReason === 'length'` | 上游**明确宣告**「输出被 max_tokens 截断」。参数结构闭合也完全可能是「正写到一半、恰好写到 `}` 但内容被截」⇒ 把它报成「模型语法写坏」**逆了本 issue 自己的初衷**（issue 要的是不要把非额度问题报成额度，反过来也不能把真截断报成语法坏），还掩盖了「真烧满额度」这一格 |
 * | 连接被掐断（既无 `finish_reason` 也无 `[DONE]`） | 断流时参数坏**更可能是分片丢失**而非模型写坏 ⇒ 报 `max-tokens` 触发重试更稳（`openai-compat` 的 `truncatedStream` 就是这条） |
 *
 * ⚠️ 第一版**漏了这两条**，实测两格都被新码抢走：
 * `坏JSON + finish=length` 与 `坏JSON + 断流` 都报出了 `TOOL_ARGS_INVALID`。
 * 而我原来的「finish=length 不回归」用例用的是**合法** JSON ⇒ 从未覆盖这个组合，
 * 全量测试一直是绿的。**这就是「守卫全绿不等于守卫生效」的又一实例。**
 *
 * ⚠️ 第 3 条的 `hasUsableToolName` 腿不可省：一个**无名**但参数合法的块本就会被
 * 丢弃（各家的 `droppedUnnamedCalls`），不该让它把整步从 `error` 拽回 `max-tokens`。
 *
 * ⚠️ `emittedProse` 必须由调用方传**同一个**已在用的值：四家对它的定义时机不同
 * （`openai-compat` 是 DSML 清洗之后的产物），本函数不替调用方做选择。
 *
 * @param invalidCount - 被判 `invalid` 的块数（调用方用 `classifyToolArguments` 算）。
 * @param emittedProse - 本步**最终发出**的正文（`block-end` 的权威文本）。
 * @param blocks - 全部工具块（只用到 `name` 与 `text`）。
 * @param upstreamTruncated - 上游是否**已宣告**被截断：`finishReason === 'length'`，
 *   或「既无 `finish_reason` 也无 `[DONE]`」（连接被掐断）。任一成立即让位给
 *   `max-tokens`。
 */
export function toolArgsInvalidIsSoleOutput(invalidCount, emittedProse, blocks, upstreamTruncated) {
    if (invalidCount === 0)
        return false;
    // ⚠️ 上游已宣告截断 ⇒ 让位给 max-tokens（见上表）。
    if (upstreamTruncated)
        return false;
    if (emittedProse !== '')
        return false;
    for (const block of blocks) {
        if (hasUsableToolName(block.name) && isUsableToolArguments(block.text))
            return false;
    }
    return true;
}
/**
 * 把「被判 invalid 的坏块」映射成 {@link toolArgsInvalidFailure} 的入参。
 *
 * 与上一个函数同一条理由：四处各写一遍 `map(entry => ({ name: entry.block.name,
 * chars: entry.block.text.length }))` 是同一份语义的 N 份实现。
 *
 * ⚠️ 用 `text.length`（**字符数**）而不是 `Buffer.byteLength`：这是给用户看的
 * 「这次调用有多长」，与 issue 里实测的「4757 字符」同一口径。
 */
export function toolArgsInvalidBlocks(entries) {
    const out = [];
    for (const entry of entries) {
        out.push({ name: entry.block.name, chars: entry.block.text.length });
    }
    return out;
}
/**
 * 构造「工具参数不是合法 JSON」的**失败原因**（`finish` 报 `error`）。
 *
 * ## 文案要回答用户的三个问题
 *
 * 1. **真实原因**：参数不是合法 JSON，且**显式否认**「输出 token 上限」与
 *    「网络中断」—— 这两个是用户最可能的错误猜想（前者来自那条固定 i18n）；
 * 2. **具体是什么**：工具名 + 字符数（让用户能定位是哪一次调用）；
 * 3. **该做什么**：直接重试即可；连续出现才换模型 / 缩小调用跨度。
 *
 * ⚠️ 文案里**不得**出现 Markdown 强调符：错误 message 是**纯文本**渲染，
 * `**不是**` 会原样显示成四个星号。与 `contentRejectionError` 同一条纪律。
 *
 * @param blocks - 坏掉的工具参数块（工具名 + 字符数）。
 */
export function toolArgsInvalidFailure(blocks) {
    // 只列前几个：一次并行下发多个坏块时，全列会把提示刷成一面墙。
    const shown = blocks.slice(0, 3)
        .map(block => `${block.name ?? '(未命名工具)'}，${block.chars} 字符`)
        .join('；');
    const scope = blocks.length > 3 ? `${shown}；等 ${blocks.length} 个调用` : shown;
    return {
        message: `模型生成的工具参数不是合法 JSON（${scope}），本次调用已丢弃。`
            + `这不是输出 token 上限，也不是网络中断 —— 直接重试即可；`
            + `若连续出现，建议更换模型或缩小该次调用的跨度`
            + `（例如上下文压缩的 startId–endId 区间）。`,
        code: TOOL_ARGS_INVALID_CODE,
    };
}
/**
 * 思考死循环中止的**错误码**。
 *
 * ## 为什么不复用 `max-tokens`（真实缺陷，Gitee !IKIZNK）
 *
 * 用户报障：循环守卫中断后，UI 显示
 * 「**已达到输出 token 上限** / 回答被截断，已有输出保留在对话中。发送"继续"可让模型接着输出。」
 *
 * ⚠️ **这句话是错的，且误导方向**：DSH 客户端对 `max-tokens` 只有这一句**固定
 * i18n 文案**（`dsh-client-ui-chat` 的 `message.maxTokens` / `.hint`），
 * **不读适配器的任何 message**。于是「检测到死循环并主动止损」被显示成
 * 「token 用满了」，用户既不知道真实原因，也被告知「继续就能接着输出」——
 * 而实测继续之后往往**立刻再次进入同一循环**。
 *
 * 全库取证（219 会话，`scripts/probe-max-tokens-provenance.mjs`）：
 * `finish=max-tokens` 的 35 步里 **25 步（71%）是循环守卫截断**，只有 5 步是
 * 真的烧满额度。且这 25 步**全部**在截断后被迫由用户手动补「继续」
 * （11× 「继续」、9× 「继续上面未完成的任务」，其中 2 次用户自己诊断出
 * 「你陷入思考循环了」）。
 *
 * ## 为什么必须是**独立且不可重试**的码
 *
 * - **独立**：UI 的 `failureMessage()` 只对 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` /
 *   `ACCOUNT_SIGNED_OUT` / `ACCOUNT_SIGN_IN_REQUIRED` 做文案替换，
 *   **其余码一律原样显示我们给的 message**（`dsh-client-ui-chat/lib/client.js`
 *   的 `failureMessage`）——故自定义码是「把真实原因送到用户眼前」的**唯一**通道。
 * - **不可重试**：`REASONING_LOOP` **刻意不在** harness 的
 *   `DEFAULT_RETRYABLE_CODES`（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` /
 *   `TIMEOUT` / `TRANSPORT`）里。死循环是**确定性**病理，白退避 5 次
 *   （500/1000/2000/4000/8000 ≈ 15.5 秒）只会再烧一轮额度。
 *   这与 `QUOTA_EXCEEDED` / `PERMISSION_DENIED` 的既有口径一致。
 */
export const REASONING_LOOP_CODE = 'REASONING_LOOP';
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
     * 命中瞬间的尾部窗口统计（供 {@link ReasoningLoopDiagnostics}）。
     *
     * ⚠️ **必须在 `feedPiece` 里就地记录**，不能等 `observe` 返回后再由调用方
     * 复算 —— 那时 `text` 已继续增长，窗口统计会与真实判据不一致。
     */
    let hitLines = 0;
    let hitDistinct = 0;
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
        // 就地记录命中瞬间的窗口统计（见 hitLines / hitDistinct 的注释）。
        hitLines = lines.length;
        hitDistinct = new Set(lines).size;
        return true;
    }
    return {
        get detected() { return detected; },
        get cutAt() { return cutAt; },
        get diagnostics() {
            if (!detected)
                return undefined;
            return {
                observedChars: text.length,
                runChars,
                lines: hitLines,
                distinctLines: hitDistinct,
                distinctLineRatio: hitLines === 0 ? 1 : hitDistinct / hitLines,
            };
        },
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
 * 构造思考死循环中止的**失败原因**（`finish` 报 `error`）。
 *
 * ## 文案要回答用户三个问题
 *
 * 用户要求（Gitee !IKIZNK）：
 * > 如果只是陷入思考循环的出错，就要给出**有分辨力**的错误提示，
 * > 现在用「达到输出 token 上限」是不对的
 * > 提示中要加上**当前窗口还有多少可用**，没有真的占满可以尝试继续任务
 *
 * 故文案必须含：
 * 1. **真实原因**：模型思考陷入病态重复，**不是** token 上限；
 * 2. **额度实况**：本次只烧掉多少、还剩多少（证明"没有真的占满"）；
 * 3. **可执行建议**：直接继续即可（因为额度还在），并提示若再次循环可降思考档位。
 *
 * ⚠️ **额度是估算**，必须如实标注：`observedChars` 是**字符数**、不是 token 数，
 * 只有 `usage` 才给权威 token 数；而守卫命中时 `reader.cancel()` 已中止上游，
 * `usage` 帧**往往根本没到达**（实测 25 例中 0 例带 usage）。
 * 故用「按经验约 1 token ≈ 3.5 字符」估算，并明确写成「约」。
 * 这个系数的选取依据：中文为主的思考文本实测 token/字符比约 1:1.5~1:2，
 * 英文短句（`OK.` / `Hmm.` / `Let me write.` 这类循环体）约 1:4~1:5，
 * 取 **3.5** 作为两者之间的保守中值 —— 宁可低估剩余额度，也不要让用户
 * 以为还有很多而反复撞墙。
 *
 * @param diagnostics - 检测器给出的命中快照；**允许 undefined**（见下）。
 * @param maxTokens - 本次请求的输出额度；undefined 表示上游未声明。
 * @param channel - 命中通道（思考 / 正文），用于文案区分。
 *
 * ⚠️ `diagnostics` 允许 undefined 是**刻意的防御**：调用点写的是
 * `loopGuard!.diagnostics!`，虽然当前实现下「`loopDetected === true` ⇒
 * `diagnostics !== undefined`」恒成立（`loopDetected` 只在 `observe()` 返回 true
 * 时置位），但**这里抛错会发生在 `finish` 路径上** —— 那是收尾的最后一步，
 * 抛错会把「有分辨力的错误」变成「连 finish 都没有」的更糟故障。
 * 故缺诊断信息时**降级成不带数值的文案**，而不是崩。
 */
export function reasoningLoopFailure(diagnostics, maxTokens, channel) {
    const label = channel === 'reasoning' ? '思考' : '正文';
    const parts = [
        `模型${label}陷入病态重复，已中止本轮（**不是**输出 token 上限）。`,
    ];
    if (diagnostics !== undefined) {
        parts.push(`判据：尾部 ${diagnostics.lines} 行里只有 ${diagnostics.distinctLines} 行不重复`
            + `（去重率 ${diagnostics.distinctLineRatio.toFixed(3)}，阈值 <0.35），`
            + `连续循环体量 ${diagnostics.runChars} 字符。`);
    }
    // ⚠️ 只有拿到 maxTokens 才能给「还剩多少」；拿不到就**不要编造**数字
    // （与 `maxOutputTokens` 那条口径一致：三者皆无则不发该字段，不编造数值）。
    if (diagnostics !== undefined && maxTokens !== undefined && maxTokens > 0) {
        const usedTokens = Math.ceil(diagnostics.observedChars / 3.5);
        const remaining = Math.max(0, maxTokens - usedTokens);
        parts.push(`本次${label}仅产出约 ${diagnostics.observedChars} 字符（约 ${usedTokens} token），`
            + `额度 ${maxTokens} token 中**还剩约 ${remaining}**（估算值）——`
            + `额度没有占满，可以直接继续任务。`);
    }
    else {
        parts.push(`额度没有占满，可以直接继续任务。`);
    }
    parts.push('若继续后再次陷入同一循环，建议降低思考档位或更换模型。');
    return { message: parts.join(''), code: REASONING_LOOP_CODE };
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
 * **闭标签**匹配式（认 hex 后缀，也认裸闭标签）—— 用作思考/正文的分界。
 *
 * ⚠️ 2026-09-27 从 `<\/think:([0-9a-f]+)>` **放宽为兼容裸标签**。
 * 放宽的依据是普查（`scripts/probe-think-forms.mjs`，41 会话全量）：
 *
 * | 形态 | 块数 | 含义 |
 * |---|---|---|
 * | `close-only-bare` | **38** | 裸 `</think>`（qoder/qfmodel 主形态）|
 * | `close-only-hex` | 4 | 既有生产路径（workbuddy）|
 * | `mixed-hex-and-bare` | 2 | 两种并存 |
 * | `paired`（开+闭）| 2 | **配对格式** |
 *
 * 旧判据只认 hex → **38 + 2 + 2 = 42 处解析失败**，原文直接落盘泄漏给用户。
 * 这正是用户指出的病根：**应先保证配对/闭标签被正确解析，过滤只是兜底**。
 *
 * ⚠️ 开标签 `<think>` **不参与定界**（实测恒缺失；仅见开标签无法判定思考边界）。
 * 它只作为「思考段内的标签」被剔除 —— 故配对形态无需单独分支（见下方注释）。
 */
const THINK_CLOSE_TAG_RE = /<\/think(?::[0-9a-f]+)?>/g;
/**
 * **任意** think 标签（开或闭，含 hex）—— 仅用于**剔除**，不用于定界。
 *
 * 配对形态 `<think>思考</think>正文` 正是靠这条把开标签剔掉：
 * 定界仍用最后一个闭标签 ⇒ 思考段 = `<think>思考` → 剔除标签 → `思考`。
 */
const THINK_ANY_TAG_RE = /<\/?think(?::[0-9a-f]+)?>/g;
/**
 * 按 **think 闭标签**把正文块拆成「思考 + 真正文」。
 *
 * ## 真实缺陷（用户报障，2026-09-25 / 2026-09-27 两次）
 *
 * **第一次**：`workbuddy/hy4-preview-f` 把**思考**写进 `content`（正文）通道，
 * 只在思考段末尾留一个 `</think:6124c78e>` 闭标签。实测该会话 93 步里只有 9 步
 * 的 reasoning 通道非空 —— 思考 9563 字符 vs 正文 64043 字符。后果：
 * ① 思考落在正文块里 → 思考死循环守卫（只喂 reasoning 增量）**完全看不见**
 * → 正文出现真循环（去重率 0.0412，实测 seq 34752/34768/34823，最长 34406 字符）；
 * ② 用户看到「模型把内心独白当正文输出」。
 *
 * **第二次**（用户报障，同一函数）：qoder/qfmodel 吐**裸** `</think>`（无 hex）。
 * 旧判据只认 `</think:hex>` → 解析失败 → 标签原样落盘。
 *
 * ## 覆盖率（41 会话全量普查，`scripts/probe-think-forms.mjs`）
 *
 * | 形态 | 块数 | 旧判据 | 现判据 |
 * |---|---|---|---|
 * | `close-only-bare`（裸闭标签）| **38** | ❌ | ✅ |
 * | `close-only-hex` | 4 | ✅ | ✅ |
 * | `mixed-hex-and-bare` | 2 | ❌ | ✅ |
 * | **`paired`（开+闭）** | 2 | ❌ | ✅ |
 *
 * ⇒ 旧判据漏 **42** 处（占 46 处中的 91%）。**这就是「解析做对」的价值** ——
 * 若只靠事后过滤，这 42 处全都会把标签泄漏给用户。
 *
 * ## 设计取舍（三条，都有实测依据）
 *
 * 1. ⚠️ **以最后一个闭标签为界**，且**剔除全部 think 标签**（开+闭）。
 *    「最后一个」保证正文完整（以第一个为界会把后续标签留在正文里）；
 *    「剔除全部」使**配对形态无需单独分支** ——
 *    `<think>思考</think>正文` 定界于闭标签 ⇒ 思考段 = `<think>思考`
 *    ⇒ 剔除标签 ⇒ `思考`。这正是「配对格式也能正确解析」的实现方式。
 * 2. ⚠️ **开标签不参与定界、只被剔除**：实测**开标签常缺失**（28 处仅闭标签），
 *    仅见开标签时无法判定「思考到哪结束」—— 此时**返回 undefined**（保持原样，
 *    比猜错安全）。
 * 3. ⚠️ **无闭标签时返回 `undefined`**（而非空切分结果）：调用方据此走原路径，
 *    保证绝大多数普通响应**逐字节不受影响**。
 *
 * ⚠️ **引用语境必须排除**（`isQuotedThinkTag`）：模型**讨论**标签时（如
 * `'</think>无 hex</think>'`）若被当分界，会把正文前半段误当思考移走。
 * 实测 46 处标签里 **39 处处于引用语境**（反引号/单双引号/围栏），只有 7 处裸露。
 *
 * @returns 命中闭标签时返回切分结果；无闭标签时返回 `undefined`。
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
    // 实测 46 处标签里 39 处是引用（含排查本缺陷时我自己复述该字面量的正文）。
    // 若只看「有没有标签」，会把这类正文的前半段误当思考移走。
    if (isQuotedThinkTag(raw, last.index))
        return undefined;
    const boundary = last.index;
    const textStart = boundary + last[0].length;
    // 思考段里可能残留更早的标签（含**开标签**与更早的闭标签），一并剔除 ——
    // 这使配对形态 `<think>思考</think>正文` 无需单独分支。
    const reasoning = raw.slice(0, boundary).replace(new RegExp(THINK_ANY_TAG_RE.source, 'g'), '');
    return { reasoning, text: raw.slice(textStart), textStart };
}
/**
 * 判断 `index` 处的标签是否处于**引用语境**，而非真泄漏分界。
 *
 * ## 为什么必须有这条判据（实测依据）
 *
 * 模型**讨论/复述**这个标签时，标签会被引号包裹。若把这类正文当分界切分，
 * 会把**正文的前半段误当思考移走**（真实风险，不是理论风险）。
 *
 * 全库普查 46 处标签（`scripts/probe-think-quote-detect.mjs`）：
 *
 * | 语境 | 处数 |
 * |---|---|
 * | 反引号包裹 / span 内 | 40+ |
 * | 单引号内（`'</think>无 hex</think>'`）| 25（与反引号共现）|
 * | 双引号内 | 3 |
 * | 代码围栏内 | 2 |
 * | **裸露（真分界）** | **7** |
 *
 * ⚠️ 其中包含**排查本缺陷时我自己输出的分析正文**（复述该字面量）——
 * 这正是「只看有没有标签会误伤」的直接证据。
 *
 * ## 四种语境都认
 *
 * 1. **行内代码**：紧邻标签的字符是反引号（`` `</think>` ``）；
 * 2. **反引号 span 内**：标签之前有**奇数个**反引号（`` `a</think>b` ``）；
 * 3. **围栏代码块**：标签之前有**奇数个** ``` 围栏；
 * 4. **同行引号内**：标签所在**行**内 `'` 或 `"` 的个数为奇数
 *    （覆盖 `'</think>无 hex</think>'` 这类测试字符串复述）。
 *
 * ⚠️ 判据 4 会**误判含撇号的英文**（`don't use </think>` 的 `don't` 有一个 `'`）。
 * 方向是**故意偏保守**：误判的后果是「该切分却没切分」（标签留在正文，
 * 由 `stripBareThinkCloseTag` 兜底），而不是「把正文当思考移走」（不可逆的内容错位）。
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
    // ② 反引号 span 内：标签之前有**奇数个**反引号（即处于未闭合的行内代码内）。
    if ((before.match(/`/g) ?? []).length % 2 === 1)
        return true;
    // ③ 围栏代码块：标签之前有**奇数个** ``` 围栏。
    const fences = raw.slice(0, index).match(/```/g);
    if (fences !== null && fences.length % 2 === 1)
        return true;
    // ④ 同行引号内：只数标签**所在行**的引号（跨行计数会误伤正常正文）。
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineBefore = raw.slice(lineStart, index);
    if ((lineBefore.match(/'/g) ?? []).length % 2 === 1)
        return true;
    if ((lineBefore.match(/"/g) ?? []).length % 2 === 1)
        return true;
    return false;
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
// ────────────────────────── DSML 标记归一化 ──────────────────────────
/**
 * 对**完整字符串**做 DSML 工具调用标记归一化（幂等）。
 *
 * ## 为什么需要（2026-10-13 实测）
 *
 * DSH 的工具调用协议是模型写在正文里的文本标记（`<｜DSML｜invoke …>`，
 * 竖线是 U+FF5C 全角竖线）。部分模型（实测 deepseek-v4.1-flash 经 OfficeAce
 * MaaS、step-5-preview 经 CodeBuddy）会把它**写坏成双竖线** `<｜｜DSML｜｜` ——
 * 宿主解析器不认，工具调用整段当正文显示，模型「停住不动」。
 *
 * 这是**分词器保真度**问题：全角双竖线常被合并成单个 token，模型难以精确
 * 复现单根。适配器是唯一能在「进入宿主解析器之前」修正的层级。
 *
 * 规则（逐条对应实测的坏形态，幂等 —— 归一化后的文本再过一遍不变）：
 * 1. `<｜{2,}DSML` → `<｜DSML`（开/闭标签左侧双竖线；`\/?` 兼容闭标签）
 * 2. `DSML｜{2,}` → `DSML｜`（右侧双竖线）
 */
export function fixDsmlMarkers(text) {
    // ⚠️⚠️ **`DSML` 后必须有分隔边界**（2026-10-13 审计修正）：不加这个前视时，
    //    正文里只要出现 `<｜｜DSMLX …` 这种**以 DSML 开头的普通词**就会被
    //    无声改掉一个竖线 —— 讨论 DSML 协议的助手、代码片段、日志转储都会中招。
    //    方向遵循仓库元规则「**宁可漏判不可误伤**」：宁可放过一个真坏标记，
    //    也不可篡改用户的合法正文。
    //    合法边界 = 竖线 / 空白 / `>` / `/` / 字符串结尾。
    //
    // ⚠️⚠️⚠️ **前视必须包含「协议标签名首字母」**（2026-10-13 二次审计修正）：
    //    原前视只列 `｜|\s|>|\/|$`，**漏了字母** ⇒ 实测形态
    //    `<｜｜DSML｜｜invoke name="…">`（右侧双竖线后紧跟 `invoke` 的 `i`）
    //    **一条都修不了**：第一段把 `<｜｜DSML` 修成 `<｜DSML`，第二段却因
    //    `DSML｜｜` 后视遇到 `i` 而跳过 ⇒ 留下 `<｜DSML｜｜invoke` 这种半修
    //    形态，比不修更糟（看起来修过、实际仍解析不了）。
    //    本文件 `dsml.ts` 的 `normalizeDsmlText` 已同步加上同一前视
    //    （两份判据必须同源，由 `dsml-label-forms.spec.ts` ⑦ 对拍锁死）。
    //
    //    合法边界的完整集合 = `｜` / 空白 / `>` / `/` / `$` **∪ 协议标签名的
    //    首字母**（`t`ool_calls、`c`alls、`i`nvoke、`p`arameter、`t`hought）。
    //    ⚠️ 不泛化成「任意字母」：那会让 `DSMLX` 这类以 DSML 开头的普通词
    //    重新被误伤（正是本轮要守住的边界）。
    //    ⚠️ `t` 同时是 `tool_calls` 与 `thought` 的首字母（字符类里去重即可）。
    const AFTER = '(?=｜|\\s|>|\\/|$|[tcip])';
    return text
        .replace(new RegExp(`(<\\/?)｜{2,}DSML${AFTER}`, 'g'), '$1｜DSML')
        .replace(new RegExp(`DSML｜{2,}${AFTER}`, 'g'), 'DSML｜');
}
/**
 * {@link fixDsmlMarkers} 的**流式安全**版本。
 *
 * ## 为什么不能逐帧直接 `replace`
 *
 * 标记会被上游切成任意片段（`<｜` + `｜DSML｜` + `｜invoke…`），逐帧 replace
 * 每帧都只见半截模式 —— 与 think 标签逐帧漏判是同一类坑（本文件上方
 * `splitThinkTaggedContent` 的注释记录过实测：二分帧 7/11 种切法漏判）。
 * 故这里持有**待定缓冲**：凡是可能构成模式前缀的尾部都扣住不发，等下一帧
 * 拼齐再判。
 *
 * 代价：文本恰好以 `<`、`<｜`、`DSML｜` 等结尾时，最后几个字符会延迟到
 * 下一帧（或 `flush()`）—— 对流式 UI 只是几字符的延迟，无正确性影响。
 */
export function createDsmlMarkerNormalizer() {
    /** 待定缓冲（可能构成模式前缀的尾部）。 */
    let pending = '';
    /** 这些模式的**真前缀**都可能还差后续输入才算得清，必须扣住。 */
    const PREFIX_PATTERNS = ['<｜｜DSML', '</｜｜DSML', 'DSML｜｜'];
    /** 最长模式长度（决定扣住窗口上限）。 */
    const MAX_PENDING = 9;
    /** 计算应扣住的尾部长度（最长匹配优先）。 */
    function holdBackLen(s) {
        const max = Math.min(s.length, MAX_PENDING);
        for (let len = max; len >= 1; len--) {
            const tail = s.slice(-len);
            if (PREFIX_PATTERNS.some((p) => p.startsWith(tail)))
                return len;
        }
        return 0;
    }
    return {
        /** 喂入一帧文本，返回可安全下发的部分（可能为空串）。 */
        push(text) {
            pending += text;
            const fixed = fixDsmlMarkers(pending);
            const hold = holdBackLen(fixed);
            const out = hold > 0 ? fixed.slice(0, fixed.length - hold) : fixed;
            pending = hold > 0 ? fixed.slice(fixed.length - hold) : '';
            return out;
        },
        /** 流结束：下发全部剩余（再做一次完整归一化兜底）。 */
        flush() {
            const out = fixDsmlMarkers(pending);
            pending = '';
            return out;
        },
    };
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
/**
 * 解析 `DSH_THINK_LEAK_STRIP`；**默认关闭**（与上文两个开关语义**相反**）。
 *
 * ## 为什么默认关（用户决定，2026-09-27）
 *
 * > 我们现在暂时不需要泄露过滤，代码可以保留，文档和注释记明白，后续再实际
 * > 使用中看是否还有泄露问题。**加了过滤可能有思考解析失败但是被过滤我们
 * > 发现不了。**
 *
 * 即：过滤是**兜底**，而兜底会**掩盖解析层的失败**。当前阶段的首要目标是
 * 观测「解析是否真的做对了」—— 若把泄漏静默删掉，就永远不知道解析是否漏了。
 * 故默认**不剥**，让泄漏**如实呈现**；确需应急时用 `DSH_THINK_LEAK_STRIP=1` 打开。
 *
 * ⚠️ **本开关只管「过滤」，不管「解析」**：
 * - **解析**（`splitThinkTaggedContent` 认配对/hex/裸闭标签）**恒开**，不可关 ——
 *   那是「把格式做对」，不是兜底。关掉它才是真缺陷（标签会进正文）。
 * - **过滤**（`stripBareThinkCloseTag` 删纯标签块）默认关 —— 它只是兜底。
 *
 * ⚠️ 取值语义与 `resolveCourseLeakStripFlag` / `resolveReasoningLoopGuardFlag`
 * **完全相反**（那两个默认开、显式假值才关）。故**必须**用独立的
 * `isTruthyFlag`，绝不能混用 —— 混了会让本开关「默认开」，正好与意图相反。
 */
export function resolveThinkLeakStripFlag(raw) {
    if (raw === undefined)
        return false;
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
/** 裸标签泄漏过滤是否启用（读环境变量）。**默认 false**。 */
export function isThinkLeakStripEnabled() {
    return resolveThinkLeakStripFlag(process.env.DSH_THINK_LEAK_STRIP);
}
/**
 * 按开关决定是否剥离纯裸标签块；**供适配器的 `block-end` 收尾处调用**。
 *
 * ⚠️ **默认不剥**（见 `resolveThinkLeakStripFlag` 的说明）：过滤会掩盖解析失败，
 * 当前阶段需要让泄漏如实呈现以便观测。确需应急时设 `DSH_THINK_LEAK_STRIP=1`。
 *
 * ⚠️ 调用位置必须在 `splitThinkTaggedContent` **之后**：切分才负责「解析」，
 * 本函数只负责「兜底删掉切分没处理掉的纯标签块」。
 */
export function stripBareThinkCloseTagIfEnabled(text) {
    return isThinkLeakStripEnabled() ? stripBareThinkCloseTag(text) : text;
}
/**
 * 剥离**纯裸 `</think>` 闭标签**的整块内容。
 *
 * ## 根因（2026-09-27）
 *
 * 模型单独吐出一个 **`\n</think>\n\n`** 的独立 text 块，既有逻辑只认
 * `</think:hex>` → 漏网之鱼，把闭标签字面量当正文发回 Web。
 *
 * ## 判据设计
 *
 * - **纯裸闭标签**（去掉首尾空白与**全部裸标签**后为空）→ 返回**空串**；
 * - **含正文的块**、引用语境、hex 标签 → **原样返回**（不做处理）。
 *   原因：① 正文明确时保留原样由下游决定；② hex 标签交给
 *   `splitThinkTaggedContent` 切分；③ 引用语境不能动（3/3 分离度）。
 *
 * ⚠️ **本函数是兜底，默认不启用**（见 `stripBareThinkCloseTagIfEnabled`）。
 * 真正负责「把标签格式解析对」的是 `splitThinkTaggedContent`。
 *
 * @returns 纯裸闭标签块 → 空串；其余 → 原样返回。
 */
export function stripBareThinkCloseTag(text) {
    const trimmed = text.trim();
    // ① 引用语境检测：先查是否被反引号或代码块围栏包裹（必须放在前面）
    if (/^`.*<\/think>.*`$/.test(trimmed))
        return text;
    let backtickCount = 0;
    for (const ch of text)
        if (ch === '`')
            backtickCount++;
    if (backtickCount % 2 === 1)
        return text;
    // ② 核心判定：去除首尾空白 + 全部裸标签 + 内部空白后，若结果为空则视为纯裸标签块
    const stripped = trimmed.replace(/<\/think>/g, '').trim();
    if (stripped.length === 0)
        return '';
    // ③ 其余情形原样返回（含 hex / 正文 / 变体）
    return text;
}
/**
 * 判定正文是否被**上游停止串**截断 —— 即「正文引用 `</think>` 导致对话中断」。
 *
 * ## 真实缺陷（用户报障，2026-09-27，本会话实时复现）
 *
 * 上游（Qwen 系，实测 `qoder/qfmodel`）把 **`</think>` 当停止串**。当模型在
 * **正文里引用**这个标签（例如讨论它、写 `` `</think>` ``）时，服务端在
 * `</think>` 处**掐断生成**，随后仍报 `finish_reason:"stop"` ——
 * 我们据此判成「模型正常答完」，harness 认为本轮已完成 → **静默中断**。
 *
 * 三条实测证据（同一会话，`outputTokens` 极小 + 正文止于半句）：
 *
 * | 行 | 正文尾部 | outTok | 正要写 |
 * |---|---|---|---|
 * | 5378 | ``…清洗器只认 ` `` | 369 | `` `</think:hex>` `` |
 * | 5412 | ``…多吐了一个孤立的裸 ` `` | 643 | `` `</think>` `` |
 * | 5600 | `` 找到了，`trae-adapter.ts` 还没补 ` `` | **37** | `` `</think>` `` |
 *
 * ## 判据（为什么是「反引号奇数 + 以反引号收尾」）
 *
 * 模型写 `` `</think>` `` 时会**先输出开引号**，服务端在标签处掐断，
 * 于是我们收到的正文**恰好止于一个未闭合的开引号**。两步判定：
 *
 * 1. **反引号总数为奇数** → 存在未闭合的行内代码；
 * 2. **以反引号收尾** → 该未闭合的正是**最后一个**开引号。
 *
 * ⚠️ 第 2 步不可省：只有「奇数」时，未闭合的开引号可能在**中间**
 * （`` `a` b ` `` 的反引号在末尾仍成立，但 `a\`b\` c\`` 这种更乱）；
 * 而「奇数 **且** 以反引号收尾」可**证明**末字符是未配对的开引号
 * （若末字符是闭引号，则它之前必然两两配对 ⇒ 总数为偶数，矛盾）。
 *
 * ⚠️ **不能用「以反引号结尾」单独判定**：正常的行内代码
 * （`` 运行 `pnpm test` ``）也以反引号结尾，但配对完整。实测该粗判据
 * 命中 9 处，其中 6 处是正常正文；本判据命中 3 处，**全部**是真截断。
 *
 * ⚠️ 本函数只管**文本形态**，是否据此上报「不完整」由调用方决定
 * （还需结合 `finish_reason === 'stop'` 与本步**没有工具调用**）。
 *
 * @returns 疑似被停止串截断时返回 `true`。
 */
export function isProseTruncatedByStopString(text) {
    if (text.length === 0)
        return false;
    const tail = text.trimEnd();
    if (tail.length === 0)
        return false;
    // ① 反引号必须为奇数（存在未闭合的行内代码）
    let ticks = 0;
    for (const ch of tail)
        if (ch === '`')
            ticks += 1;
    if (ticks % 2 === 0)
        return false;
    // ② 必须以未闭合的开引号收尾（或半个标签，服务端可能已吐出一部分）
    return /`$/.test(tail) || /<$/.test(tail) || /<\/think$/.test(tail);
}
//# sourceMappingURL=sse.js.map