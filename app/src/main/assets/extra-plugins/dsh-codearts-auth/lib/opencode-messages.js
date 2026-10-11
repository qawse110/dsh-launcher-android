/**
 * OpenAI chat payload 构造 + FreeTier 形状门禁注入。
 *
 * ## 门禁依据（设计文档 §0.6，opencode2dsh 2026-09-18 实测）
 *
 * 匿名通道拒绝**不带 agent 形状**的 body，回 403 FreeTierError，除非
 * `stream: true` 且 `tools` 里有名为 `bash` 与 `read` 的 function 工具
 * （描述 / parameters / 全部请求头都不检查）。
 *
 * ⚠️ 门禁参数**收敛在本文件**，不散落到适配器 —— 服务端再收紧时只改一处。
 * ⚠️ 账号槽（带 API key）**同样注入**：免费通道与认证通道的服务端策略
 * 可能共用同一层形状检查，多注入一层对认证通道无害（官方 CLI 本来也带
 * 全套工具），但缺了它就可能让匿名槽整体失效。
 */
/** 门禁工具名（服务端只认这两个名字）。 */
export const FREE_LANE_GATE_TOOLS = ['bash', 'read'];
/** 门禁桩工具：描述固定为「不要调用」，参数为空对象。 */
function gateTool(name) {
    return {
        type: 'function',
        function: {
            name,
            description: 'Reserved for the host runtime; do not call it.',
            parameters: { type: 'object', properties: {} },
        },
    };
}
/**
 * DSH 工具 → wire 工具。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。不下发它，模型在 wire 上看不到
 * 任何函数定义，只能用正文里的 XML 臆造工具调用 —— qoder 的用户报障
 * 「执行任务出现任务调用 xml 泄露任务终止」就是这个根因。
 */
export function buildOpencodeTools(tools) {
    if (tools === undefined || tools.length === 0)
        return [];
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            ...(tool.description.length > 0 ? { description: tool.description } : {}),
            ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
        },
    }));
}
/**
 * 注入门禁工具，必要时补 `tool_choice`。
 *
 * ⚠️ `tool_choice: 'none'` **只在原本一个工具都没有时**补：真实工具在列时
 * 覆盖用户的自选 tool_choice 会改变模型行为（模型将无法调用任何工具，
 * 而 harness 仍在等它调用 —— 表现为工具执行不推进）。
 *
 * @returns 满足门禁的 body；已满足或非 chat body 时**返回同一引用**。
 */
export function ensureFreeLaneShape(payload) {
    if (!Array.isArray(payload.messages))
        return payload;
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const names = new Set();
    for (const tool of tools) {
        if (typeof tool !== 'object' || tool === null)
            continue;
        const fn = tool.function;
        if (typeof fn?.name === 'string')
            names.add(fn.name);
    }
    const missing = FREE_LANE_GATE_TOOLS.filter((name) => !names.has(name));
    if (missing.length === 0)
        return payload;
    return {
        ...payload,
        tools: [...tools, ...missing.map(gateTool)],
        ...(tools.length === 0 ? { tool_choice: 'none' } : {}),
    };
}
/** 构造一次 chat 请求的完整 body（已过门禁）。 */
export function buildOpencodePayload(input) {
    const base = {
        model: input.model,
        messages: input.messages,
        // ⚠️ 恒 true：这是门禁的一半要求。
        stream: true,
        tools: buildOpencodeTools(input.tools),
        ...input.system !== undefined && input.system.length > 0 ? { system: input.system } : {},
        ...typeof input.temperature === 'number' && Number.isFinite(input.temperature)
            ? { temperature: input.temperature }
            : {},
        // ⚠️ 只放行安全正整数：0 / 负数 / NaN 会让 DSH 侧抛
        // INVALID_MODEL_MAX_TOKENS，把整轮对话搞崩（不是降级，是崩）。
        ...Number.isSafeInteger(input.maxTokens) && (input.maxTokens ?? 0) > 0
            ? { max_tokens: input.maxTokens }
            : {},
        // ⚠️ 思考档位（issue IKJJ0V）。**声明了档位就必须真的发出去**，
        // 否则选择器只是 UI 装饰 —— 用户选了「高」却拿不到任何效果。
        //
        // 参数名 `reasoning_effort` 由**实测**确定（2026-10-02）：给
        // `ling-3.0-flash-fin-free` 传非法值时，错误信息变成 `[400] reasoning_…`
        // （与基线的 `Endpoint is unavailable` 不同），说明 Zen 侧确实解析并校验它。
        //
        // ⚠️ `none`（关闭思考）照发：models.dev 的 `toggle` 形态就产出这一档，
        // 上游靠它区分「关」与「最低档开」。
        ...typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0
            ? { reasoning_effort: input.reasoningEffort }
            : {},
    };
    return ensureFreeLaneShape(base);
}
//# sourceMappingURL=opencode-messages.js.map