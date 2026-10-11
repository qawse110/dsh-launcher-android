/**
 * 从各渠道目录**推导**虚拟模型表：`虚拟模型(规范键) → 候选条目[]`。
 *
 * ## 输入从哪来
 *
 * 装配层把每个 provider 的 `ctx.llm.listModels(provider)` 结果传进来。⚠️ 该结果
 * **已被各适配器按用户黑名单过滤**（每个 `listModels` 内部都套了
 * `disabledModelsFor`）⇒ 被用户关闭的模型**天然不会**成为候选，无需在本层再筛。
 *
 * ## 两条不变的输出约定
 *
 * 1. **候选条目保留真实 id 与真实展示名**：面板子列表要逐行显示「哪个渠道的哪个
 *    modelId」，用户据此核查合并是否正确并逐条拒绝（设计文档 §7.1）；
 * 2. **虚拟模型按候选数降序、候选按渠道名升序**：降序让冗余度高的模型在前
 *    （渠道多 = 更不容易挂）；升序让面板与日志的顺序可比对。
 *
 * @module src/aggregate-catalog.ts
 */
import { canonicalDisplayName, canonicalKeyFor } from './canonical-models.js';
import { priceFactorFromName } from './aggregate-core.js';
/**
 * 构建虚拟模型表。
 *
 * @param catalogs - `provider → 该渠道的目录`（应已按用户黑名单过滤）。
 * @returns 虚拟模型数组：候选数降序，同数按 key 升序（结果稳定、可断言）。
 */
export function buildVirtualModels(catalogs) {
    const byKey = new Map();
    for (const [provider, models] of Object.entries(catalogs)) {
        for (const model of models) {
            // ⚠️ 必须用 `trim()` 判空，不能只判 `length === 0`（评审实测）：
            // `{ id: ' ' }` 归一后得到 `key === ''`、`name === ''` 的退化虚拟模型，
            // 而 DSH 的 `listModels` 校验要求 `name` 非空 —— **整个聚合目录会因此
            // 抛 INVALID_CATALOG 而不可用**（`canonical-models.ts` 的模块注释里也
            // 警告过这个失效形态）。真实目录给空白的概率极低，但代价是全局的。
            if (typeof model?.id !== 'string' || model.id.trim().length === 0)
                continue;
            const realName = typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id;
            const mapped = canonicalKeyFor(provider, model.id, realName);
            if (mapped === undefined)
                continue;
            const entry = {
                provider,
                realId: model.id,
                realName,
                price: priceFactorFromName(realName),
                via: mapped.via,
            };
            const list = byKey.get(mapped.key);
            if (list === undefined)
                byKey.set(mapped.key, [entry]);
            else
                list.push(entry);
        }
    }
    const models = [];
    for (const [key, candidates] of byKey.entries()) {
        // 同一虚拟模型下**同一个渠道**理论上可能有两条候选 —— 都保留，让用户在
        // 子列表里逐条看到并决定。
        //
        // ⚠️ 这个分支**当前真实数据里未观察到**，是防御性的：要发生它，需要某个
        // 渠道同时满足「走 `name` 通道（只有 qoder / qodercn）」且「两条不同 realId
        // 归一后的展示名相同」。探针实测该机制真实存在
        // （`canonicalKeyFor('qoder','gfmodel','GLM-5.3-Flash')` 与
        // `('qoder','gfmodel_x','GLM-5.3-Flash')` 同键），只是尚未在真实目录里见到。
        //
        // ⚠️ **不要**照抄本注释初版里的「buddy 的 `hy3` / `hy3-x` 都归一成 `hy3`」——
        // 那是**错的**：buddy 走 `id` 通道，实测 `hy3` 与 `hy3-x` 是两个不同的规范键
        //（`CANONICAL_NAMES` 也把它们登记为两个独立条目）。该错误示例源自计划初稿，
        // 评审实测后订正。
        candidates.sort((a, b) => (a.provider !== b.provider
            ? a.provider.localeCompare(b.provider)
            : a.realId.localeCompare(b.realId)));
        models.push({ key, name: canonicalDisplayName(key), candidates });
    }
    // 候选数降序；同数按 key 升序（稳定结果，便于断言与面板顺序稳定）。
    models.sort((a, b) => (b.candidates.length !== a.candidates.length
        ? b.candidates.length - a.candidates.length
        : a.key.localeCompare(b.key)));
    return models;
}
//# sourceMappingURL=aggregate-catalog.js.map