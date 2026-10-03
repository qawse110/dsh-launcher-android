export function toOpenAiModelId(provider, model) {
    return `${provider}/${model}`;
}
/**
 * 采集全量模型目录，**逐个 provider 兜住**。
 *
 * ⚠️ 不能直接 `Promise.all` 全部 provider：任一 provider 抛错（未登录、远端
 * 目录拉取失败）会让整个目录变成失败 —— 用户看到的是「网关坏了」，而真实原因
 * 只是某一个 provider 没登录。逐个跳过也让「无凭据的 provider 不出现在目录里」
 * 天然成立。
 *
 * ⚠️ **本函数承诺永不抛出**。它是「网关面板顺带展示的目录」，是附加信息，
 * 不该有能力把调用方（设置页状态读取、请求失败后的纠错建议）一起拖垮。
 * 故对下列畸形输入全部降级为空：方法缺失、`listProviders()` 返回非数组、
 * 某个 `listModels()` 返回非数组、provider 条目缺 id。
 * （`llm` 来自 DSH 的 service，真实形态与类型声明可能不一致，故不假设它守规矩。）
 */
export async function collectGatewayModels(llm, onError) {
    let providers = [];
    try {
        const raw = llm?.listProviders?.();
        if (Array.isArray(raw))
            providers = raw.filter((entry) => typeof entry?.id === 'string');
    }
    catch (error) {
        onError?.('listProviders', error);
    }
    if (providers.length === 0)
        return [];
    const groups = await Promise.all(providers.map(async ({ id: provider }) => {
        try {
            const models = await llm.listModels(provider);
            if (!Array.isArray(models)) {
                onError?.(provider, new Error('listModels 未返回数组'));
                return undefined;
            }
            return { provider, models: models };
        }
        catch (error) {
            onError?.(provider, error);
            return undefined;
        }
    }));
    return groups.filter((group) => group !== undefined);
}
/**
 * 采集成设置页可直接渲染的 `{ id, name, input }` 列表。
 *
 * 与 {@link toOpenAiModels} 共用同一份采集逻辑与容错口径 —— 用户在设置页看到的
 * 与 `/v1/models` 返回的**必须**是同一批 ID 与同一份能力声明，两处各算一遍必然
 * 漂移，而漂移的症状是「照着设置页选的模型却不支持图片」。
 *
 * ⚠️ `input` 原样透传**不归一化**：它决定用户能否给该模型发图片，而各 provider
 * 的能力声明才是权威（`/v1/models` 的 HTTP 路径同样直接输出它）。
 * 缺失时归一化为 `['text']`，与各适配器「不声明即按 text 保守处理」一致
 * （见 lobsterai-adapter.ts:768-770）——宁可少报能力，也不要让用户发一张
 * 注定被上游拒绝的图。
 */
export async function collectGatewayModelIds(llm, onError) {
    const groups = await collectGatewayModels(llm, onError);
    return groups.flatMap(({ provider, models }) => models.map((model) => ({
        id: toOpenAiModelId(provider, model.id),
        name: model.name,
        input: Array.isArray(model.inputModalities) && model.inputModalities.length > 0
            ? [...model.inputModalities]
            : ['text'],
    })));
}
/** 将 DSH 的 provider 分组目录转换为 OpenAI models 响应中的 data 项。 */
export function toOpenAiModels(groups) {
    return groups.flatMap(({ provider, models }) => models.map((model) => ({
        id: toOpenAiModelId(provider, model.id),
        object: 'model',
        created: 0,
        owned_by: provider,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...model.contextWindow === undefined ? {} : { context_window: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { max_tokens: model.maxTokens },
        ...model.inputModalities === undefined ? {} : { input: model.inputModalities },
    })));
}
//# sourceMappingURL=models.js.map