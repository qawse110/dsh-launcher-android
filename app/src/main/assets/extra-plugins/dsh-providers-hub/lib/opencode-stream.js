/**
 * V2 响应边界：在共享 SSE 消费器建块之前还原工具名、归一缺失的 index。
 * 不能在 block-end 才还原：早期 delta 的别名或保留工具已经可能被宿主执行。
 * 名字跨帧拼接，参数仍逐帧交给消费器。
 *
 * ⚠️ 未知/保留/残缺名字一律**剔除该次调用**（去掉 name 后照原样下发），
 * **不得**整轮报错。三条理由（2026-10-15 真机实测）：
 * 1. 只广告门禁 `read`（＝调用方没传工具，`toolsDisabled`）时，模型**会**去调它
 *    —— 同一句「读取 /tmp/a.txt」，`big-pickle` 多次产出 `read{path}` 调用
 *    （3 次独立观测；**非必然**：另有一次它直接作答）。若此处抛错，整轮对话
 *    直接死掉，已流出的正文也一并作废。
 * 2. 共享消费器对**无名** tool-call 已有既定语义：**不发任何 chunk**（不执行、也不会把
 *    `unknown tool ""` 写进会话；注意它在内部**仍登记**一条不会 `announced` 的调用，
 *    见下一段），又在没有别的可用调用时报 `max-tokens`（`droppedUnnamedCalls`，
 *    见 `openai-compat.ts`）—— 这正是「模型想调工具但被剔除」的既有信号，
 *    不必另造一种失败（Issue IKLRIK 的同一口径）。
 * 3. 上游把名字切成分片是常态（实测 big-pickle / mimo 的续帧是
 *    `{"name":null}`），把「名字还没拼完」当错误会让正常流偶然致命。
 *
 * ⚠️ 正因为消费器**仍登记**坏调用，剔除时**必须连参数一起丢掉**：它的 `argsTruncated`
 * 遍历全部调用块（含未 `announced` 者），坏调用的半截参数会把同批**合法**调用也拖成
 * `max-tokens`（宿主丢弃并重试 ⇒ 合法调用白丢一轮）。残留一格：名字晚于参数到达
 * （真机名字都在首帧，未观察到）时，早到的参数字节已进消费器，无法回收。
 *
 * 真正 fail-closed 的只剩**线上歧义**（同名 id 或同下标指向两条不同调用、
 * 名字已确定后又改口）：那时无法判断参数属于谁，执行谁都是错的。
 *
 * ⚠️ 如实登记的边界（2026-10-15 独立审计 + 对抗性审计确证机制）：
 * - 前缀歧义只能靠「参数到了没有」判断名字是否已完整（见 `restore` 的 `longer`）。
 *   故**纯分片**若恰好先给出一个短别名、参数又已到、随后才补长名，也会落进
 *   「改口」这条 fail-closed ⇒ **整轮失败**。线上未观察到该切法（真机名字整帧
 *   到达 + `name:null` 续帧），但机制可达、代码分不清「模型改口」与「我们猜早了」。
 * - 反之，若歧义直到收尾都没消解（如同时启用 `read` 与 `read_image`，上游只给
 *   `dsh_read` 且**一个参数字节都没有**），这条**本可执行**的无参调用会被剔除。
 * - 同一次请求同时广告客户端 `read`（别名 `dsh_read`）与门禁 `read` 时，同名调用
 *   结局相反：调 `dsh_read` 执行、调裸 `read` 被剔除（门禁名永不还原，见 `restore`）。
 *   刻意保留：把裸 `read` 当客户端调用执行＝把**门禁调用**猜成客户端意图，而门禁
 *   schema 是 `{path}`、客户端 `read` 要 `{file_path}`，猜错就是执行一个模型没打算
 *   调的工具；剔除的代价只是这一次调用没发生（有 warn 留痕）。
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import { ALIAS_PREFIX, FREE_LANE_GATE_TOOLS } from './opencode-messages.js';
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
export function createOpencodeFrameNormalizer(request, warn) {
    const choices = new Map();
    const aliases = request.toolAliases;
    const candidates = [...aliases.keys(), ...FREE_LANE_GATE_TOOLS];
    const fail = (detail) => {
        // 不用 AUTH/QUOTA：客户端会吞掉具体文案；不标记账号、不换槽重发同一坏调用。
        throw new LlmError(`opencode: ${detail}`, 'PERMISSION_DENIED');
    };
    /**
     * 告警出口。⚠️ **`warn` 抛异常绝不能打死本轮**（2026-10-15 审计确证：
     * `dropCall` 在 `TransformStream.transform` 里同步调它，抛了就变成流错误 ⇒
     * 又回到「一次模型行为打死整轮对话」，与被剔除的初衷正相反）。
     */
    const note = (detail) => {
        try {
            warn?.(`opencode: ${detail}`);
        }
        catch {
            // 日志副作用失败不影响数据面：正文与合法调用照常返回。
        }
    };
    /**
     * 剔除一条调用：只记一条 warn，不抛错。
     * 宿主日志里能看见「哪个名字被扔了」，而本轮正文与其它合法调用不受影响。
     */
    const dropCall = (call, detail) => {
        if (call.warned)
            return;
        call.warned = true;
        note(`${detail}（已剔除该次调用，本轮其余内容照常返回）`);
    };
    /** 剔除原因文案：必须指路，且不得把**我们自己**的缺陷记到模型头上。 */
    const dropReason = (name) => {
        if (name.length === 0)
            return '上游工具调用始终没有名字';
        if (FREE_LANE_GATE_TOOLS.includes(name))
            return `上游调用了保留门禁工具 ${name}`;
        // `dsh_` 是本插件自己的别名前缀：出现它意味着别名表或历史重命名可能有缺陷
        // （模型回叫历史里的裸原名是合理行为），与「模型幻觉出 ghost 这种名字」不同因。
        if (name.startsWith(ALIAS_PREFIX))
            return `上游返回了未声明的别名 ${name}（dsh_ 是本插件自己的前缀，请查别名表与历史重命名）`;
        return `上游返回了未声明的工具名 ${name}`;
    };
    const stateOf = (index) => {
        let state = choices.get(index);
        if (state === undefined) {
            state = { calls: [], byId: new Map(), byIndex: new Map(), finished: false };
            choices.set(index, state);
        }
        return state;
    };
    const newCall = (state) => {
        const call = { index: state.calls.length, upstreamName: '', restored: false, hasArguments: false };
        state.calls.push(call);
        return call;
    };
    /** 把一条已放弃的调用从 id/下标槽里摘掉（见 `targetOf` 的复用说明）。 */
    const unhook = (state, stale) => {
        for (const [id, call] of state.byId)
            if (call === stale)
                state.byId.delete(id);
        for (const [index, call] of state.byIndex)
            if (call === stale)
                state.byIndex.delete(index);
        if (state.current === stale)
            state.current = undefined;
    };
    const targetOf = (state, call) => {
        const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined;
        const rawIndex = Number.isSafeInteger(call.index) && call.index >= 0 ? call.index : undefined;
        let target = id === undefined ? undefined : state.byId.get(id);
        const fn = record(call.function);
        if (target === undefined && rawIndex !== undefined) {
            target = state.byIndex.get(rawIndex);
            // 无 index 首帧后续补 index：优先按 id，否则按隐式创建序号绑定。
            const candidate = state.calls[rawIndex];
            if (target === undefined && candidate !== undefined && (id === undefined || candidate.id === undefined))
                target = candidate;
        }
        if (target === undefined && rawIndex === undefined && id === undefined) {
            // 带分片 name 的续传也必须回到当前调用，不能误建一条新调用。
            if (state.current !== undefined && (!state.current.restored || !fn?.name))
                target = state.current;
        }
        // ⚠️ 已被剔除的调用**永远拿不回名字**（名字只增不减、且它已不可能长成候选）。
        // 此时同 id/下标又来一个**非空名字片段**，只可能是上游在该槽上开了另一条调用 ——
        // 真机续传帧是 `"name":null`（fixture 第 17 行），不会误判。必须另立一条，
        // 否则新调用的名字会被拼进死调用（`read` + `dsh_pwsh`）而**一条告警都没有**地消失
        // （2026-10-15 对抗性审计确证；带 id 的同一形态走 `fail('身份冲突')`，静默只在不带 id 时出现）。
        if (target !== undefined && target.warned === true && typeof fn?.name === 'string' && fn.name.length > 0) {
            unhook(state, target);
            target = undefined;
        }
        target ??= newCall(state);
        if (id !== undefined) {
            if (target.id !== undefined && target.id !== id)
                fail('上游工具调用身份冲突');
            target.id = id;
            state.byId.set(id, target);
        }
        if (rawIndex !== undefined) {
            const existing = state.byIndex.get(rawIndex);
            if (existing !== undefined && existing !== target)
                fail('上游工具调用下标冲突');
            state.byIndex.set(rawIndex, target);
        }
        state.current = target;
        return target;
    };
    const restore = (fn, target) => {
        const fragment = typeof fn.name === 'string' ? fn.name : '';
        if (fragment && fragment !== target.upstreamName) {
            if (target.restored)
                fail('上游在工具名称已确定后更改了名称');
            target.upstreamName += fragment;
        }
        const name = target.upstreamName;
        const next = { ...fn };
        delete next.name;
        // ⚠️ `toolsDisabled` 时**任何**名字都不做别名还原：调用方明确关掉了工具，
        // 这条不变式必须在响应层逐调用强制（不能只靠「描述里写了别调」）。
        const exact = request.toolsDisabled ? undefined : aliases.get(name);
        const longer = candidates.some((candidate) => candidate !== name && candidate.startsWith(name));
        target.hasArguments ||= typeof fn.arguments === 'string' && fn.arguments.length > 0;
        if (exact !== undefined && (!longer || target.hasArguments || target.restored)) {
            if (!target.restored)
                next.name = exact;
            target.restored = true;
            return next;
        }
        // `longer` 为假 ⇒ 当前名字**永不可能再长成任何候选**（名字只增不减），这条调用
        // 注定还原不出来（可还原的那格已在上面 return）⇒ 立刻剔除，并**把参数一并丢掉**：
        // 共享消费器的 `argsTruncated` 遍历**全部**调用块（含未 announced 的坏调用），
        // 半截参数会把同批**合法**调用也拖成 `max-tokens` ⇒ 宿主丢弃并重试 ⇒ 白丢一轮
        // （2026-10-15 审计确证；`arguments` 缺失处消费器按 `normalizeToolArguments` 归一）。
        if (!longer) {
            dropCall(target, dropReason(name));
            delete next.arguments;
        }
        return next;
    };
    /**
     * 收尾检查：收尾时仍未还原的调用一律**剔除 + 留痕**（上游把名字切碎是常态，
     * 共享消费器本来就会丢弃无名块）。此处只告警，不抛错。
     *
     * ⚠️ 判据必须是「没还原」而不是「名字非空」（2026-10-15 对抗性审计确证的空洞）：
     * 名字**从未到达**时 `longer` 被空串吸收（`candidate.startsWith('')` 恒真），旧写法
     * 在这里被 `upstreamName.length > 0` 挡住 ⇒ 调用凭空消失且**零告警**，
     * 正是本仓库登记的「『空』被当成『正常的无』」那一类缺陷。
     */
    const assertState = (state) => {
        for (const call of state.calls) {
            if (call.restored)
                continue;
            const pending = candidates.some((candidate) => candidate !== call.upstreamName && candidate.startsWith(call.upstreamName));
            if (call.upstreamName.length === 0)
                dropCall(call, dropReason(''));
            // 名字停在某个候选的前缀上 ⇒ 是**歧义**（无法判定它还会不会长），不是「残缺」：
            // 如同时启用 `read` 与 `read_image` 时上游只给 `dsh_read`，文案不该说名字不完整。
            else if (pending)
                dropCall(call, `上游工具名称与另一个候选前缀重叠（${call.upstreamName}），无法判定是否已完整`);
            else
                dropCall(call, `上游工具名称不完整（${call.upstreamName}）`);
        }
    };
    return {
        transformFrame(frame) {
            if (!Array.isArray(frame.choices))
                return;
            for (const raw of frame.choices) {
                const choice = record(raw);
                if (choice === undefined)
                    continue;
                const index = Number.isSafeInteger(choice.index) ? choice.index : 0;
                const state = stateOf(index);
                if (state.finished) {
                    // 已完成 choice 的迟到帧只保留顶层 usage，不重新打开工具块。
                    delete choice.delta;
                    continue;
                }
                const delta = record(choice.delta);
                const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
                const legacy = record(delta?.function_call);
                // ⚠️ 这里**刻意没有**「未启用工具却收到调用就报错」的早退：那会把一次模型
                // 行为（只广告了门禁 `read` 时它去调 `read`）升级成整轮失败。该不变式由
                // `restore()` 逐调用强制 —— `toolsDisabled` 时任何名字都不还原别名，
                // 全部走剔除，一个调用都到不了宿主。
                if (delta !== undefined) {
                    const normalized = calls.map((rawCall) => {
                        const call = record(rawCall);
                        if (call === undefined)
                            fail('上游返回了畸形工具调用');
                        const target = targetOf(state, call);
                        const fn = record(call.function) ?? {};
                        return { ...call, index: target.index, function: restore(fn, target) };
                    });
                    // 兼容旧 function_call 帧：统一交给共享 tool_calls 消费器，不丢参数。
                    if (legacy !== undefined) {
                        state.legacy ??= newCall(state);
                        normalized.push({ index: state.legacy.index, id: `call_legacy_${index}`, function: restore(legacy, state.legacy) });
                        delete delta.function_call;
                    }
                    if (normalized.length > 0)
                        delta.tool_calls = normalized;
                }
                if (choice.finish_reason) {
                    const finish = String(choice.finish_reason);
                    // 声称 tool_calls/function_call 却一个调用都没活下来：自相矛盾的帧。
                    // ⚠️ 理由要写准（2026-10-15 对抗性审计证伪了旧注释）：原样下发**不会**让宿主
                    // 等一个永不到来的工具结果 —— 宿主见「零 tool-call 块」直接判 completed；
                    // 但那是**静默**的「正常答完」。降级为 stop 后由共享消费器走既有语义定夺：
                    // 被剔除的无名调用报 max-tokens，零调用零块报 EMPTY_RESPONSE（可重试的显式错）。
                    if (!state.calls.some((entry) => entry.restored)
                        && (finish === 'tool_calls' || finish === 'function_call')) {
                        choice.finish_reason = 'stop';
                        // ⚠️ 只有**一个调用都没有**时才补留痕：那才是真正的「上游自相矛盾」，而且
                        // 没有别的告警解释它；若调用是被剔除的，各调用的剔除告警已经把原因讲清了，
                        // 再补一条只会让「每条调用最多一条 warn」变成刷屏。
                        if (state.calls.length === 0)
                            note(`上游声称 ${finish} 却没有任何工具调用（finish_reason 已降级为 stop）`);
                    }
                    assertState(state);
                    state.finished = true;
                }
            }
        },
        assertComplete() {
            for (const state of choices.values())
                assertState(state);
        },
    };
}
/**
 * OpenCode 专用 SSE 前置流，不改共享消费器，也不缓冲整条响应。
 * 只在完整 SSE 事件边界改写 JSON；正文/思考/usage 字段仍由共享消费器原样处理。
 * pipeThrough 保留背压与取消传播，调用方停止消费时上游连接也会被取消。
 */
export function normalizeOpencodeResponse(response, request, warn) {
    if (response.body === null)
        return response;
    const normalizer = createOpencodeFrameNormalizer(request, warn);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let lines = [];
    let format;
    const emit = (controller) => {
        if (lines.length === 0)
            return;
        const original = lines.join('\n');
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim();
        let output = original;
        if (data === '[DONE]')
            normalizer.assertComplete();
        else if (data) {
            let parsed;
            try {
                parsed = JSON.parse(data);
            }
            catch { /* 非 JSON 留给共享消费器诊断。 */ }
            const frame = record(parsed);
            if (frame !== undefined) {
                normalizer.transformFrame(frame);
                const metadata = lines.filter((line) => !line.startsWith('data:'));
                output = [...metadata, `data: ${JSON.stringify(frame)}`].join('\n');
            }
        }
        controller.enqueue(encoder.encode(`${output}\n\n`));
        lines = [];
    };
    const takeLines = (controller) => {
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (line === '')
                emit(controller);
            else
                lines.push(line);
        }
    };
    const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            if (format === undefined && buffer.trimStart()) {
                // HTTP 200 + 裸 JSON/HTML 错误也可能不结束；立即透传给共享消费器诊断。
                format = /^[{[<]/.test(buffer.trimStart()) ? 'raw' : 'sse';
            }
            if (format === 'raw') {
                controller.enqueue(encoder.encode(buffer));
                buffer = '';
                return;
            }
            takeLines(controller);
        },
        flush(controller) {
            buffer += decoder.decode();
            if (format === 'raw') {
                if (buffer)
                    controller.enqueue(encoder.encode(buffer));
                return;
            }
            takeLines(controller);
            if (buffer)
                lines.push(buffer.replace(/\r$/, ''));
            emit(controller);
            normalizer.assertComplete();
        },
    }));
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
//# sourceMappingURL=opencode-stream.js.map