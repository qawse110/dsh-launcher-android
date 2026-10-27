/**
 * Accio 的协议层：消息序列化 + SSE **帧归一化**。
 *
 * ## 为什么复用 `consumeGeminiSse`（用户 2026-10-12 裁定）
 *
 * Accio 与 Gemini 是**同一族协议**（Gemini 风格信封 + `content.parts[]` +
 * `thought` 标记 + `usage_metadata`）。⇒ 本模块只做**一层薄归一化**，
 * 把 Accio 的帧包成标准 Gemini 形状，再交给 `src/gemini-messages.ts` 的 `consumeGeminiSse`。
 *
 * ⚠️ **必须复用而不是重写**：那个消费器里的逻辑**全是踩坑换来的**，重写必然重新踩：
 * 1. `readWithIdleTimeout` —— 裸 `reader.read()` 在上游长时间不 flush 时**无限期挂起**
 *    （症状：「发消息后永远转圈」）；
 * 2. 结束时**先 flush 解码器**、再把余量按整行走一遍 —— 否则**最后一条事件被丢弃**；
 * 3. `noteUsage` 取**最大** `totalTokenCount` —— 上游多帧重复播报且早期帧偏小；
 * 4. 工具调用**独占一块**、参数一次性发完；
 * 5. **空响应必须抛错** —— 静默结束会让 harness 认为「正常回答但没内容」，**不会重试**；
 * 6. 跳过注释行心跳（`:` 开头）。
 *
 * ⚠️ **不共用 provider 配置**：`gemini-messages.ts` 是**协议层**，不含 gemini 的
 * OAuth / 项目号 / 配额语义；本模块不 import `gemini-product.ts` / `gemini-auth.ts` /
 * `gemini-credits.ts`，也**不复用** `GEMINI_GENERATE_PATH`（那是 Cloud Code 的路径）。
 *
 * ## 两种帧形状的差异（本模块存在的唯一理由）
 *
 * | | Accio | 标准 Gemini |
 * |---|---|---|
 * | 帧 | `{content:{parts}, usage_metadata, partial}` ← **顶层** | `{candidates:[{content}], usageMetadata}` |
 * | 工具 | `parts[].function_call`（snake，`args_json` 是**字符串**） | `parts[].functionCall`（camel，`args` 是**对象**） |
 *
 * ⚠️ **两行都必须归一化，缺一行工具调用就整体失效**：`consumeGeminiSse` 判工具调用的
 * 判据是 `part.functionCall !== undefined`，且它把 `part.functionCall.args` 交给
 * `canonicalArgs` 序列化。只包顶层 `candidates` 而**不转 part**，运行时表现是
 * 「帧被认成纯 usageMetadata 帧 ⇒ 无内容块 ⇒ 抛『模型未返回任何内容块』」，
 * 即**参考实现记录过的「读 camelCase 名会静默得到 0 个工具调用」同型缺陷**。
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import { consumeGeminiSse } from './gemini-messages.js';
/**
 * Accio 的**流内**错误码：额度/认证失败以 HTTP 200 + 本码下发。
 *
 * ## 为什么必须在这里识别（真实缺陷，Task 3 复审查出）
 *
 * 实测（agent-notes §4.2 的四格矩阵）：把 token 放进 `Authorization` 头而非
 * body 的 `token` 字段时，上游**恒**回
 * `HTTP 200 + data: {"turn_complete":true,"error_code":"402","error_message":"unauthorized"}`。
 * 这种帧**没有 `content`** ⇒ {@link normalizeAccioFrame} 返回 `undefined` ⇒
 * 原先的 `continue` 把**整帧丢掉** ⇒ 流结束时 `consumeGeminiSse` 抛
 * `gemini: 模型未返回任何内容块`。
 *
 * 症状极具误导性（与 agent-notes §4.3 记的完全一致）：用户看到的是
 * 「模型没返回内容」，而不是「额度/认证问题」，harness 也不会按额度类重试。
 */
const ACCIO_QUOTA_ERROR_CODE = '402';
/**
 * 额度错误码 —— **字面量 `'QUOTA_EXCEEDED'`，不是 harness 常量**。
 *
 * ⚠️ harness 导出的 `QUOTA_EXCEEDED_CODE` 字面值是 **`'QUOTA'`**，而 DSH 客户端
 * 对 `'QUOTA'` / `'ACCOUNT_QUOTA'` / `'AUTH'` 三个码会**丢弃适配器写的 message、
 * 换成一句固定文案**（`message.failure.quota` = 「当前请求的额度已用尽」）⇒
 * 上游原文（`402 unauthorized`）一个字都到不了用户眼前，也丢掉了「去重新登录 /
 * 充值」这个唯一有效动作的线索。
 *
 * 这与 `src/llm-adapter.ts` 的 `CODEARTS_QUOTA_EXHAUSTED_CODE`、
 * `src/openai-compat.ts` / `src/trae-adapter.ts` / `src/minimax-adapter.ts` 等
 * 约 20 处额度产出点**同一口径**（见 `docs/agent-notes/client-ui.md` 的铁律
 * 「凡是要把自定义文案送到用户眼前，码必须避开这三个」）。
 */
const ACCIO_QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';
/**
 * 该帧是否是**流内错误帧**（布尔判据）。
 *
 * ## 判据（三条，缺一不可）
 *
 * 1. **对象且带非空 `error_code`**（或 `error_message`）—— Accio 的错误帧
 *    `{"turn_complete":true,"error_code":"402","error_message":"unauthorized"}`；
 * 2. ⚠️ **`error_code === '200'` 是成功哨兵，绝不可抛** —— 实测正常帧也会带它
 *    （`{"error_code":"200","content":{…}}`）。故必须先判 `'200'` 再判错误；
 * 3. 其余非 `200` 码 ⇒ 错误（归类见 {@link accioErrorFrame}）。
 *
 * ## ⚠️⚠️ 为什么必须**导出**成独立的布尔判据（2026-10-13 审计修正）
 *
 * 合并层 `accioToolCallMergeTransform`（`src/accio-adapter.ts`）跑在
 * `consumeAccioSse` **之前**，而本判据只在后者的 `processLine` 里生效。若合并层把
 * 「错误码与工具 part **同帧**」的帧吸收进 pending 缓冲，flush 时只吐工具 part
 * ⇒ `error_code` / `error_message` 被吞 ⇒ 本判据再也看不到它 ⇒
 * **额度/认证失败被反转成「工具调用成功」**（本仓库铁律「流内错误必须抛出」
 * 「绝不丢服务端原文」同时被违反）。
 *
 * ⇒ 合并层必须能问一句「这是不是错误帧」，对错误帧**原样透传、绝不吸收**。
 *
 * ⚠️ **判据只此一处**（{@link accioErrorFrame} 复用它）—— 两处各写一份必然漂移，
 * 漂移的后果是「同一个帧，一层认作错误、另一层认作正常」。
 */
export function isAccioErrorFrame(frame) {
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame))
        return false;
    const f = frame;
    const rawCode = f.error_code ?? f.errorCode;
    const rawMessage = f.error_message ?? f.errorMessage;
    const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : '';
    const message = typeof rawMessage === 'string' ? rawMessage : '';
    if (code === '' && message === '')
        return false;
    // ⚠️ 成功哨兵：`error_code: "200"`（实测正常帧会带）**必须先于**错误判据返回，
    // 否则每一条正常响应都会被当成错误抛掉。
    return code !== '200';
}
/**
 * 把一帧解析后的报文判定为**流内错误帧**（是则返回该抛的错误，否则 `undefined`）。
 *
 * `'402'`（字符串或数字）⇒ `QUOTA_EXCEEDED`；其余非 `200` 码 ⇒ 通用错误，
 * 且**逐字带上服务端原文**（本仓库铁律：绝不丢服务端原文）。
 *
 * ⚠️ **返回错误而不是就地 `throw`**：调用点在**同一个 chunk** 里可能已经攒了
 * 若干条正常帧（`out` 数组），就地抛出会让它们连 `controller.enqueue` 都执行不到
 * 而被静默丢弃。故判据与抛出**分离**，由调用点在把已攒下的行交出去**之后**再抛。
 */
function accioErrorFrame(frame) {
    if (!isAccioErrorFrame(frame))
        return undefined;
    const f = frame;
    const rawCode = f.error_code ?? f.errorCode;
    const rawMessage = f.error_message ?? f.errorMessage;
    const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : '';
    const message = typeof rawMessage === 'string' ? rawMessage : '';
    // ⚠️ 文案逐字保留（`error_code` 与 `error_message` 都带），便于排障与对账。
    const detail = [code === '' ? '' : `error_code=${code}`, message].filter((s) => s !== '').join(' ');
    if (code === ACCIO_QUOTA_ERROR_CODE) {
        return new LlmError(`accio: 额度或认证失败（${detail}）`, ACCIO_QUOTA_EXCEEDED_CODE);
    }
    return new LlmError(`accio: 上游返回错误帧（${detail}）`, 'SERVER');
}
/**
 * 图片像素预算（本轮**不发送**图片）。
 *
 * ⚠️ 实测 `multimodal: true` 的模型**声明**支持图片，但本 provider 的图片通路
 * **尚未实测**（见 agent-notes §10 U-D）。按本仓库铁律「输入形态三态」：
 * 未验证 ⇒ 该在 `resolveModel` 里**省略** `inputModalities`（= 未知），
 * 本适配器因此不走图片路径。保留该常量是为了让 `readImage` 的接入点显式可见，
 * 而不是被静默省略。
 */
export const ACCIO_IMAGE_PIXEL_BUDGET = 1_150_000;
/** 把 `snake_case` 的用量字段映射为 camelCase（`consumeGeminiSse` 认后者）。 */
function mapUsage(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const u = raw;
    const pick = (...keys) => {
        for (const k of keys) {
            const v = u[k];
            if (typeof v === 'number' && Number.isFinite(v))
                return v;
        }
        return undefined;
    };
    const out = {};
    const prompt = pick('promptTokenCount', 'prompt_token_count');
    const candidates = pick('candidatesTokenCount', 'candidates_token_count');
    const total = pick('totalTokenCount', 'total_token_count');
    const cached = pick('cachedContentTokenCount', 'cached_content_token_count');
    const thoughts = pick('thoughtsTokenCount', 'thoughts_token_count');
    if (prompt !== undefined)
        out.promptTokenCount = prompt;
    if (candidates !== undefined)
        out.candidatesTokenCount = candidates;
    if (total !== undefined)
        out.totalTokenCount = total;
    if (cached !== undefined)
        out.cachedContentTokenCount = cached;
    if (thoughts !== undefined)
        out.thoughtsTokenCount = thoughts;
    return Object.keys(out).length > 0 ? out : undefined;
}
/**
 * 解析 Accio 响应里的参数串（`args_json`）→ 对象。
 *
 * ⚠️ 返回 `undefined` 表示「这一帧里**没有可用的字符串参数**」（空串 / 非字符串 /
 * JSON 非法）⇒ 调用方退到 `{}`，与 `gemini-messages.ts` 的 `parseToolArguments`
 * 同口径（那里同样把不可解析的参数串退化为 `{}`，**不编造**具体键）。
 *
 * ⚠️ **已知缺口（Task 6 接工具时复核）**：agent-notes §4.4 记录上游的工具调用是
 * **分片到达**的（首帧只给 `{id,name}`、后续帧补 `args_json`）。本层**不做跨帧按 id
 * 合并** —— 对上「首帧只有 name」的形态会产出一个 `args` 为 `{}` 的调用。
 * 合并若要补，应补在**适配器**（它能看到整条流），不应塞进这个纯函数层。
 */
function parseArgsJson(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 归一化一个 `part`。
 *
 * ⚠️ 只处理**工具调用**这一种需要换名的 part；`text` / `thought` / 其它 part
 * **原样返回同一引用**（`thought` 由 `consumeGeminiSse` 映射成 `reasoning`，
 * 本层不得改写它的语义）。
 *
 * ⚠️ `function_call` 的形状（agent-notes §4.4）：响应是 **snake_case**，
 * 参数在 **`args_json` 字符串**里；而 `consumeGeminiSse` 要的是 camelCase
 * `functionCall.name` + **对象** `functionCall.args`（它自己再 `canonicalArgs` 序列化）。
 * 名字缺失的调用**整块丢弃**（产出无名工具调用会让上游/适配器 400）。
 */
function normalizeAccioPart(part) {
    if (part === null || typeof part !== 'object')
        return undefined;
    const raw = part;
    const call = raw.functionCall ?? raw.function_call;
    if (call === null || typeof call !== 'object')
        return part;
    const c = call;
    const name = typeof c.name === 'string' && c.name !== '' ? c.name : undefined;
    if (name === undefined)
        return undefined;
    // 参数三种形态：Accio 响应的字符串 `args_json`（实测）→ 标准 Gemini 的对象 `args`
    // → camelCase 的 `argsJson`（容忍上游改用 camel）。
    const args = parseArgsJson(c.args_json ?? c.argsJson)
        ?? (typeof c.args === 'object' && c.args !== null && !Array.isArray(c.args)
            ? c.args
            : {});
    const out = { functionCall: { name, args } };
    // 签名机制：Accio 未实测下发 ⇒ 只在真有值时透传（不编造、不丢字段）。
    if (typeof raw.thoughtSignature === 'string' && raw.thoughtSignature !== '') {
        out.thoughtSignature = raw.thoughtSignature;
    }
    return out;
}
/**
 * 把一帧 Accio 报文归一化成 `consumeGeminiSse` 认得的形状。
 *
 * ⚠️ 已经是标准形状（含 `candidates`）时**原样返回同一引用** ——
 * 容忍上游某天改成标准形状，也便于测试断言。
 *
 * ## ⚠️⚠️ 「无 `content`」≠「无用帧」（2026-10-13 真实缺陷，用户报障
 * 「accio 思考一下就中断」的根因之一）
 *
 * 旧判据「无 `content` 一律 `return undefined`」把三类**有语义**的帧整帧丢弃：
 *
 * 1. **顶层 `function_call`**（agent-notes §4.2 的 task-6-report 逐字记录的
 *    真实形状 `{"function_call":{"id":…,"name":…}}`，**不带** `content`）——
 *    丢弃它 = 模型的工具调用凭空消失，流里只剩思考 ⇒ 兜底 `stop` ⇒
 *    「思考一下就中断、无正文无工具调用、轮次显示正常完成」；
 * 2. **终帧的 `usage_metadata` / `finish_reason`**（与 `content` 同为顶层字段，
 *    工具轮次的终帧只有它们、没有正文）—— 丢弃它 = `MAX_TOKENS` 截断被
 *    伪装成正常 `stop`，usage 恒归零；
 * 3. 纯 usage 帧（无 finish）—— 丢弃它 = 计量丢失。
 *
 * 实测证据（session `35b01df3`，accio/deepseek-v4-1-flash 13 轮静默 stop）：
 * 每轮思考结尾都是工具意图（"Let me call get_goal."），然后流里再无任何内容；
 * 唯一拿到真实 usage 的轮次恰好是纯文本轮次（终帧带 `content`，usage 搭车存活）。
 *
 * ## 产出形状的取舍
 *
 * - 仅 usage（无 finish）⇒ `{candidates:[], usageMetadata}`：消费侧对空
 *   `candidates` 只记用量、不算内容、继续读（见 `consumeGeminiSse` 的
 *   `processFrame`），**不会**触发「模型未返回任何内容块」；
 * - 有 finish ⇒ `candidates:[{finishReason}]`（**不带** `content`）：
 *   `finishReason` 只有挂在**非空** candidate 上才会被读到（空 candidates
 *   在读 finishReason 之前就 return 了）；
 * - 顶层 `function_call` ⇒ 包成 `candidates[0].content.parts[].functionCall`，
 *   复用 {@link normalizeAccioPart} 做 snake → camel 换名。
 */
export function normalizeAccioFrame(frame) {
    if (frame === null || typeof frame !== 'object')
        return undefined;
    const f = frame;
    // 已是标准形状：透传（同一引用）
    if (Array.isArray(f.candidates))
        return frame;
    const usage = mapUsage(f.usage_metadata ?? f.usageMetadata);
    const finish = f.finish_reason ?? f.finishReason;
    const finishText = typeof finish === 'string' && finish !== '' ? finish : undefined;
    const content = f.content;
    if (content === null || typeof content !== 'object') {
        // 顶层 function_call（无 content 信封）：包成标准 part 形状，绝不丢。
        const topCall = f.function_call ?? f.functionCall;
        if (topCall !== null && typeof topCall === 'object') {
            const part = normalizeAccioPart({ function_call: topCall });
            if (part !== undefined) {
                const candidate = { content: { role: 'model', parts: [part] } };
                if (finishText !== undefined)
                    candidate.finishReason = finishText;
                return { candidates: [candidate], ...(usage !== undefined ? { usageMetadata: usage } : {}) };
            }
            // ⚠️⚠️ 调用**无名**（`normalizeAccioPart` 判据）⇒ 该调用整块丢弃，这是既有约定
            // （产出无名工具调用会让上游/适配器 400）。**但 usage / finish 绝不能被连坐丢掉**
            // （2026-10-13 审计修正：原先此处直接 `return undefined`）。
            //
            // 连坐的后果是可观测的，而且正是本 PR 要消灭的那一类：同一个「无名 part +
            // MAX_TOKENS + usage」形状，放在 `content.parts` 里得到 `finish=max-tokens`
            // + 真实 usage，放在**顶层**却得到 `finish=stop` + usage 全零 ⇒
            // **MAX_TOKENS 截断被伪装成正常结束，harness 不会重试**。
            // 故丢掉调用之后**继续往下走**，由下面「终帧 / 纯 usage 帧」那条分支保住元数据。
            // （与紧邻的 `function_call: null` / 完全无 call 两格判据一致。）
        }
        // 终帧 / 纯 usage 帧：保住 usage 与 finish 语义。
        if (usage === undefined && finishText === undefined)
            return undefined;
        if (finishText !== undefined)
            return { candidates: [{ finishReason: finishText }], ...(usage !== undefined ? { usageMetadata: usage } : {}) };
        return { candidates: [], usageMetadata: usage };
    }
    // ⚠️ parts 必须逐个过一遍：工具调用的 snake → camel 换名发生在这里
    // （只包 `candidates` 是不够的，见文件头）。
    const normalizedContent = { ...content };
    const rawParts = content.parts;
    if (Array.isArray(rawParts)) {
        const parts = [];
        for (const part of rawParts) {
            const normalized = normalizeAccioPart(part);
            if (normalized !== undefined)
                parts.push(normalized);
        }
        normalizedContent.parts = parts;
    }
    const out = { candidates: [{ content: normalizedContent }] };
    if (usage !== undefined)
        out.usageMetadata = usage;
    // finish_reason 上游可能给在顶层
    if (finishText !== undefined) {
        ;
        out.candidates[0].finishReason = finishText;
    }
    return out;
}
/**
 * 工具定义 → Accio 的 `{ name, description, parametersJson }`（**扁平**形态）。
 *
 * ## ⚠️⚠️ 形状是**实测**的扁平形态，不是 Gemini 的 `{function_declarations:[…]}`
 *
 * 经 `accioToSnake` 后落成 `tools[].parameters_json`。真机证据见
 * `docs/agent-notes/providers-accio.md` §4.1.2（Task 6 的 `probe-tool-shards.mjs` /
 * `probe-tool-merge.mjs` 用的就是这个形态，上游回了真实 `function_call` 帧）。
 *
 * ⚠️ **`parametersJson` 必须是字符串**（`JSON.stringify` 整份 schema）：
 * `accioToSnake` **不下钻字符串** ⇒ 工具参数名（`filePath` / `oldString` …）作为
 * **数据**原样送达。若改成对象形态，递归 snake 化会**静默改写参数名**。
 * 详见 `src/accio.ts` 的 `buildAccioBody` tools 区域那段警告。
 */
export function toAccioTools(tools) {
    if (!Array.isArray(tools))
        return undefined;
    const out = [];
    for (const tool of tools) {
        const fn = tool?.function;
        if (fn === undefined || typeof fn.name !== 'string' || fn.name === '')
            continue;
        out.push({
            name: fn.name,
            description: typeof fn.description === 'string' ? fn.description : '',
            parametersJson: JSON.stringify(fn.parameters ?? { type: 'object', properties: {} }),
        });
    }
    return out.length > 0 ? out : undefined;
}
/** 从 content 里抽纯文本（数组时取 `text` 块）。 */
function flattenText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('');
}
/**
 * 把一条 user 消息的 content 转成 Accio 的 `parts`（**含图片**）。
 *
 * ## 上游形状（2026-10-14 真机实测，issue IKLR7V）
 *
 * 图片放在 **Gemini 风格的 `parts[].inline_data = { mime_type, data }`** ——
 * 与既有 `contents` 信封**同构**，且实测四象限色块图**四色全对**。
 * 本函数产出 camelCase 形态，由 `buildAccioBody` 的 `accioToSnake` 转成上游认的
 * `inline_data`（⚠️ **不要**改走 `properties` 子树 —— 那棵子树刻意不参与 snake 转换）。
 *
 * ## 三态判据（缺一不可）
 *
 * | 情形 | 行为 |
 * |---|---|
 * | 无图 | 返回 `undefined` ⇒ 调用方走**原来的纯文本路径**（线上格式逐字节不变，不破坏前缀缓存） |
 * | 有图、字节已内联 | 产出 `{ inlineData: { mimeType, data } }` |
 * | 有图、拿不到字节 | **抛错**（绝不静默丢弃；静默丢弃会让用户以为模型看到了图） |
 *
 * ⚠️ **`tool-result` 分支必须递归**，与 `collectImages`（`src/openai-compat.ts`）
 * 的递归深度**对称**：收集侧是任意深度，序列化侧只走一层的话，深层图片会被
 * 收进 refs 却在序列化时**静默丢弃**（连占位符都没有）。本仓库其余适配器
 * （buddy / trae / lobsterai）都按同一口径递归。
 *
 * @param content - 消息的 content（数组形状）。
 * @param images - `attachmentId → 已内联字节`。`undefined` 表示**本请求无图**
 *   （调用方未接线或未收集到）；此时不产出图片 part。
 */
export function accioUserParts(content, images) {
    const parts = [];
    let hasImage = false;
    for (const raw of content) {
        if (raw === null || typeof raw !== 'object')
            continue;
        const block = raw;
        if (block.type === 'text') {
            const text = String(block.text ?? '');
            if (text !== '')
                parts.push({ text });
            continue;
        }
        if (block.type === 'image') {
            hasImage = true;
            const attachmentId = block.attachment?.attachmentId;
            const inline = typeof attachmentId === 'string' ? images?.get(attachmentId) : undefined;
            if (inline === undefined) {
                // ⚠️ 显式抛错，不静默丢弃（与 gemini-messages.ts 同一口径）。
                throw new LlmError('accio: 图片未能内联（附件服务不可用或读取失败），拒绝发出缺少图片的请求', 'UNSUPPORTED_CONTENT');
            }
            parts.push({ inlineData: { mimeType: inline.mediaType, data: inline.data } });
            continue;
        }
        if (block.type === 'tool-result' && Array.isArray(block.content)) {
            const inner = accioUserParts(block.content, images);
            if (inner !== undefined) {
                hasImage = true;
                parts.push(...inner);
            }
            else {
                // 内层无图：保留其文本，避免内容丢失。
                const text = flattenText(block.content);
                if (text !== '')
                    parts.push({ text });
            }
        }
    }
    return hasImage && parts.length > 0 ? parts : undefined;
}
/**
 * 把 harness 消息序列化成 Accio 的 `contents` + `systemInstruction`。
 *
 * ⚠️ 调用方**必须**先走 `normalizeHarnessMessages(...)`（DSH 0.1.7 的一等
 * `role:'tool'` 消息）—— 本函数按 0.1.5 形状实现，与其余适配器同口径。
 *
 * ## 图片（`images`）
 *
 * `images` 为 `undefined` 表示**本请求没有图片**（未接线 / 未收集到）⇒ user 消息
 * 走**原来的纯文本路径**，线上格式逐字节不变（不破坏前缀缓存）。
 * 非 `undefined`（**含空 Map**）时才可能把带图的 user 消息升级为多模态 `parts`。
 *
 * ⚠️ 图片的实际提取由 {@link accioUserParts} 负责（含 `tool-result` 递归）；
 * 本函数只决定「哪条消息要用它」。
 */
export function serializeAccioMessages(messages, images) {
    const contents = [];
    const system = [];
    for (const raw of messages ?? []) {
        const message = raw;
        const role = message?.role;
        if (role === 'system' || role === 'developer') {
            const text = flattenText(message?.content);
            if (text !== '')
                system.push(text);
            continue;
        }
        if (role === 'tool') {
            const content = message?.content;
            contents.push({
                role: 'user',
                parts: [{
                        functionResponse: {
                            id: typeof message?.tool_call_id === 'string' ? message.tool_call_id : '',
                            name: typeof message?.name === 'string' ? message.name : '',
                            responseJson: typeof content === 'string' ? content : JSON.stringify(content ?? {}),
                        },
                    }],
            });
            continue;
        }
        if (role === 'assistant') {
            const parts = [];
            const text = flattenText(message?.content);
            if (text !== '')
                parts.push({ text });
            const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
            for (const call of calls) {
                const c = call;
                const fn = c.function;
                // ⚠️ `argsJson` 必须是**原始参数串**，不是解析后的对象
                parts.push({
                    functionCall: {
                        id: typeof c.id === 'string' ? c.id : '',
                        name: typeof fn?.name === 'string' ? fn.name : '',
                        argsJson: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
                    },
                });
            }
            if (parts.length > 0)
                contents.push({ role: 'model', parts });
            continue;
        }
        // user（以及任何未识别的角色，按最安全的 user 处理）
        //
        // ⚠️ **含图时走 `accioUserParts`**（它把文本与图片合成同一条 parts 序列）：
        // 图片必须与文本**同一条消息**（分成两条会让模型看到「第一句是问题、
        // 第二句是一张没有上下文的图」）。
        const outer = Array.isArray(message?.content)
            ? message.content
            : undefined;
        const parts = outer === undefined || images === undefined
            ? undefined
            : accioUserParts(outer, images);
        if (parts !== undefined) {
            contents.push({ role: 'user', parts });
            continue;
        }
        const text = flattenText(message?.content);
        if (text !== '')
            contents.push({ role: 'user', parts: [{ text }] });
    }
    return { contents, systemInstruction: system.join('\n\n') };
}
/**
 * 消费 Accio 的 SSE。
 *
 * ⚠️ **必须用 `TransformStream` 在中间改写帧**：`consumeGeminiSse` 内部对每帧做
 * `JSON.parse` 且**不接受「帧变换」回调**，而 Accio 的帧需要先归一化它才认得。
 * 故这里先流式改写，再把改写后的流交给共享消费器。
 *
 * ⚠️ 改写的五条纪律：
 * 1. **非 `data:` 行原样透传**（`event:` / 注释心跳 / 空行都要保留）；
 * 2. **`[DONE]` 原样透传**（消费器认它）；
 * 3. 归一化返回 `undefined` 的帧**整帧丢弃**（不能产出空 `candidates`）；
 * 4. **流内错误帧必须抛出**（`error_code` 非 `'200'`）—— 见
 *    {@link accioErrorFrame}；漏掉它会把「额度/认证失败」误判成「模型没返回内容」；
 * 5. **结束时 flush 解码器**（与共享消费器同一条教训）—— 否则跨 chunk 的
 *    最后一个多字节字符会丢。
 */
export function consumeAccioSse(options) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    // ⚠️ 错误帧**不就地抛**：同一个 chunk 里可能已经攒了正常帧（`out`），
    // 就地抛会让它们连 `enqueue` 都执行不到而被静默丢弃。故先记下来，
    // 把已攒下的行交出去之后再抛（见 {@link accioErrorFrame}）。
    // ⚠️ 提到 transform/flush 之外共享：flush 里处理的尾行同样可能是错误帧。
    let pendingError;
    /** 处理一行（裁 `\r` → 错误判据 → 归一化）；产物推进 `out`。 */
    const processLine = (line, out) => {
        const trimmedEnd = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (!trimmedEnd.startsWith('data:')) {
            out.push(trimmedEnd);
            return;
        }
        const payload = trimmedEnd.slice(5).trim();
        if (payload === '' || payload === '[DONE]') {
            out.push(trimmedEnd);
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(payload);
        }
        catch {
            return;
        }
        // ⚠️ 错误判据必须在归一化**之前**：错误帧没有 `content`，归一化恒返回
        // `undefined`，原先的 `continue` 会把它整帧丢掉（本任务修的真实缺陷）。
        const error = accioErrorFrame(parsed);
        if (error !== undefined) {
            pendingError ??= error;
            return;
        }
        const norm = normalizeAccioFrame(parsed);
        if (norm === undefined)
            return;
        out.push(`data: ${JSON.stringify(norm)}`);
    };
    const rewritten = options.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            const out = [];
            for (const line of lines)
                processLine(line, out);
            if (out.length > 0)
                controller.enqueue(encoder.encode(`${out.join('\n')}\n`));
            if (pendingError !== undefined)
                throw pendingError;
        },
        flush(controller) {
            // ⚠️⚠️ 尾行必须走**同一条归一化路径**，不能裸透传（2026-10-13 wire 探针定罪）：
            // 实测上游流以终帧收尾、**没有 `[DONE]`**；合并层（accioToolCallMergeTransform）
            // 的 flush 产物也**不带尾换行** ⇒ `transform` 把这行留在 buffer ⇒
            // 若这里裸透传，`consumeGeminiSse` 收到的是**未归一化**的 Accio 顶层帧
            // （无 `candidates`）⇒ 被当纯 usageMetadata 帧 ⇒ 工具调用/usage/finish 全丢
            // —— 正是「思考一下就中断」在第一轮修复后仍复发的缺口。
            // 先刷解码器里的残留多字节序列（见文件头第 2 条教训），再把余量当一行处理。
            buffer += decoder.decode();
            const out = [];
            if (buffer !== '')
                processLine(buffer, out);
            if (out.length > 0)
                controller.enqueue(encoder.encode(`${out.join('\n')}\n`));
            if (pendingError !== undefined)
                throw pendingError;
        },
    }));
    return consumeGeminiSse({
        body: rewritten,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    });
}
//# sourceMappingURL=accio-messages.js.map