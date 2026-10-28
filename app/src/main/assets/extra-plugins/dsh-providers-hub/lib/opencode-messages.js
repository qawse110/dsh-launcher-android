/**
 * 门禁工具名。
 *
 * ⚠️ **只保留 `read`**：实测「只带 read」必定放行，而只带 shell/edit/write/glob
 * 一律 403。少注入一个门禁就少一个与客户端工具重名的干扰源 —— 模型偶发选中
 * 注入的 shell 桩会让整轮退化/被上游限流。
 */
export const FREE_LANE_GATE_TOOLS = ['read'];
/**
 * 门禁桩工具。名字与参数 schema 必须保持上游 read 的形态（改名或空 properties 都会 403）。
 * 描述**不参与校验**（空描述同样放行），故用最直白的禁止调用文案，不再拼业务原句，
 * 也就不会与客户端自己的工具描述混淆。
 */
export function gateTool(name) {
    return {
        type: 'function',
        function: {
            name,
            description: 'Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File or directory to read' },
                    offset: { type: 'integer', minimum: 0, description: 'Starting line or directory entry (1-based)' },
                    limit: { type: 'integer', minimum: 0, description: 'Maximum lines or directory entries to read' },
                },
                required: ['path'],
                additionalProperties: false,
            },
            strict: false,
        },
    };
}
/** 只做 DSH → OpenAI 格式转换，别名统一在请求边界分配。 */
export function buildOpencodeTools(tools) {
    return (tools ?? []).map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            ...(tool.description.length > 0 ? { description: tool.description } : {}),
            ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
        },
    }));
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
function renameCall(value, names) {
    const call = record(value);
    const fn = record(call?.function);
    const alias = typeof fn?.name === 'string' ? names.get(fn.name) : undefined;
    return alias === undefined ? value : { ...call, function: { ...fn, name: alias } };
}
function renameChoice(value, names) {
    const choice = record(renameCall(value, names));
    if (!Array.isArray(choice?.tools))
        return choice ?? value;
    return {
        ...choice,
        tools: choice.tools.map((tool) => {
            const next = record(renameCall(tool, names));
            const alias = typeof next?.name === 'string' ? names.get(next.name) : undefined;
            return alias === undefined ? next ?? tool : { ...next, name: alias };
        }),
    };
}
function renameMessage(value, names) {
    const message = record(value);
    if (message === undefined)
        return value;
    let next = message;
    if (Array.isArray(message.tool_calls)) {
        next = { ...next, tool_calls: message.tool_calls.map((call) => renameCall(call, names)) };
    }
    const fn = record(message.function_call);
    const alias = typeof fn?.name === 'string' ? names.get(fn.name) : undefined;
    if (alias !== undefined)
        next = { ...next, function_call: { ...fn, name: alias } };
    if (message.role === 'function' && typeof message.name === 'string' && names.has(message.name)) {
        next = { ...next, name: names.get(message.name) };
    }
    return next;
}
/**
 * 客户端工具的上游别名前缀。
 *
 * ⚠️ **唯一定义处**：响应层的剔除判据要用它区分「我们自己的产物」（`dsh_` 开头 ⇒
 * 别名表或历史重命名可能有缺陷）与「模型幻觉的名字」—— 两处各写一份字面量
 * 会在改前缀时静默漂移（本仓库已登记「一文件两套同义判据」这条判据）。
 */
export const ALIAS_PREFIX = 'dsh_';
/** 不修改调用者对象；每个请求仅调用一次，响应层必须使用返回的同一份映射。 */
function adaptPayload(payload) {
    const toolsDisabled = payload.tool_choice === 'none' || !Array.isArray(payload.tools) || payload.tools.length === 0;
    const tools = toolsDisabled ? [] : payload.tools.filter((tool) => {
        const fn = record(record(tool)?.function);
        return typeof fn?.name === 'string' && fn.name.length > 0;
    });
    const present = new Set(tools.map((tool) => tool.function.name));
    const names = new Map();
    for (const tool of tools) {
        const name = tool.function.name;
        if (names.has(name))
            continue;
        const base = `${ALIAS_PREFIX}${name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 60);
        let alias = base;
        let suffix = 1;
        while (present.has(alias)) {
            const tail = `_${suffix++}`;
            alias = `${base.slice(0, 64 - tail.length)}${tail}`;
        }
        present.add(alias);
        names.set(name, alias);
    }
    const clientTools = tools.map((tool) => ({
        ...tool,
        function: {
            ...tool.function,
            name: names.get(tool.function.name),
            description: `Client tool "${tool.function.name}"; use "${names.get(tool.function.name)}" for the client's "${tool.function.name}" operation. ${tool.function.description ?? ''}`,
        },
    }));
    const body = {
        ...payload,
        tools: [...clientTools, ...FREE_LANE_GATE_TOOLS.map(gateTool)],
        stream: true,
        stream_options: { include_usage: true },
    };
    // ⚠️ 实测（2026-10-15，匿名通道 big-pickle/mimo/longcat）：V2 **接受**显式
    // `tool_choice:none`（HTTP 200），但后端**不执行**它 —— 同一句「读取 /tmp/a.txt」
    // 在 `tool_choice:none` 下照样产出 `read` 调用。故「不发 none」不是为了过门禁
    // （门禁只看 body 里 tools 的形状），而是因为发了也没有约束力、徒增一处分歧；
    // 禁用与保留工具的隔离**必须**由响应层逐调用强制（见 `opencode-stream.ts`）。
    if (toolsDisabled || payload.tool_choice == null)
        delete body.tool_choice;
    else
        body.tool_choice = renameChoice(payload.tool_choice, names);
    if (names.size > 0 && Array.isArray(payload.messages)) {
        body.messages = payload.messages.map((message) => renameMessage(message, names));
    }
    return { payload: body, toolAliases: new Map([...names].map(([name, alias]) => [alias, name])), toolsDisabled };
}
/** 兼容既有纯 payload 调用；生产链路用 buildOpencodeRequest 同时取回响应映射。 */
export function ensureFreeLaneShape(payload) {
    return Array.isArray(payload.messages) ? adaptPayload(payload).payload : payload;
}
export function buildOpencodeRequest(input) {
    return adaptPayload({
        model: input.model,
        // chat 协议没有顶层 system；只转发 DSH 自己的提示，不注入 OpenCode 身份模板。
        messages: input.system ? [{ role: 'system', content: input.system }, ...input.messages] : input.messages,
        tools: buildOpencodeTools(input.tools),
        ...typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? { temperature: input.temperature } : {},
        // 不擅自使用模型上限作默认预算；仅在调用方明确指定时下发 max_tokens。
        ...Number.isSafeInteger(input.maxTokens) && (input.maxTokens ?? 0) > 0 ? { max_tokens: input.maxTokens } : {},
        ...typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0 ? { reasoning_effort: input.reasoningEffort } : {},
    });
}
export function buildOpencodePayload(input) {
    return buildOpencodeRequest(input).payload;
}
//# sourceMappingURL=opencode-messages.js.map