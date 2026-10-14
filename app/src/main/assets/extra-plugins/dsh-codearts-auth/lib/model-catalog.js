/**
 * 模型目录的**共享骨架**（设计文档 §3.5.4）。
 *
 * ## 它解决什么
 *
 * 14 家的 `listModels` / `resolveModel` / `listAllModels` 三个方法此前各自实现，
 * 但骨架**逐字同构**（实测：`loomy` / `minimax` / `raccoon` 三家归一化后逐字相同）：
 *
 * ```
 * listModels(provider)
 *   ├─ ① providerCatalogVisible(accountPool, product.id)?
 *   │      └─ 否 → 返回 []，**绝不抛错**
 *   ├─ ② 读目录（远端缓存 ?? 兜底表）
 *   ├─ ③ 黑名单过滤（disabledModelsFor）
 *   └─ ④ map → { provider: product.id, id, name, inputModalities }
 *
 * resolveModel(provider, model)      ← ⚠️ provider/id 必须按入参回填
 *   ├─ ① 按 id 找 entry（**找不到不抛错**）
 *   ├─ ② name：entry.bareName → entry.name → **裸 model**（三级回退，绝不空）
 *   │      ⚠️ **`bareName` 优先**，与设计文档 §3.5.4.3 写的「entry.name →
 *   │         entry.bareName」**相反** —— 以实现为准，理由见 `resolveModel` 内注释。
 *   │         （本节原先把顺序写反了，2026-10-08 复审修正。）
 *   ├─ ③ context：未知就不声明
 *   ├─ ④ maxTokens：可选
 *   └─ ⑤ reasoning：efforts 非空才声明；defaultEffort 必须落在 efforts 内
 * ```
 *
 * 各家仍在自己模块内做一次 `toCatalogEntry()` —— 把「私有形状」转成本文件的
 * `CatalogEntry`。此后共享骨架**不再关心原始形状**。
 *
 * ## ⚠️ 边界（别把这里做成「一套配置驱动 14 家」）
 *
 * 抽象的是**骨架**（顺序、回填、三态、过滤），**不是协议**：
 * - 倍率是否拼进 `name`、怎么剥掉 —— 各家在 `toCatalogEntry` 里决定；
 * - `inputModalities` 的**两种来源**（静态表按 id 查 / 远端对象读字段）——
 *   在 `toCatalogEntry` 里收敛成**一个字段**；
 * - 兜底表长什么样 —— 各家私有（`loadCatalog` 内部自己选）。
 */
import { providerCatalogVisible } from './account-pool.js';
export function createModelCatalog(deps, config) {
    const providerId = config.product.id;
    /**
     * `listAllModels()` 用的同步视图。
     *
     * ⚠️ 缓存的是 `loadCatalog()` 的**成功结果**，而**不是**「读到了远端」——
     * 因为 `loadCatalog` 内部已经做过「远端 ?? 兜底」的选择，它返回的**就是**
     * 当前该展示的全量目录。未调用过时回落到 `syncCatalog()`。
     */
    let cached;
    /** 把 `CatalogEntry` 摊成 `LlmModelInfo` 的公共字段（三态在这里落实）。 */
    function toModelInfo(entry) {
        const info = { provider: providerId, id: entry.id, name: entry.name };
        // ⚠️ 三态：只有 `!== undefined` 才写入 —— 写 `['text']` 会明确声明不支持图片。
        if (entry.inputModalities !== undefined)
            info.inputModalities = entry.inputModalities;
        if (entry.description !== undefined)
            info.description = entry.description;
        return info;
    }
    return {
        async listModels(provider) {
            // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider
            // 分组隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的
            // failures，界面上反而多一条 provider 报错）。
            if (!await providerCatalogVisible(deps.accountPool, providerId))
                return [];
            const all = await config.loadCatalog();
            cached = all;
            const disabled = deps.accountPool?.disabledModelsFor(providerId);
            const listed = disabled === undefined || disabled.size === 0
                ? all
                : all.filter((entry) => !disabled.has(entry.id));
            return listed.map(toModelInfo);
        },
        async resolveModel(provider, model, _signal) {
            const all = await config.loadCatalog();
            cached = all;
            const entry = all.find((item) => item.id === model);
            // ⚠️ name 三级回退，**绝不空**（空名会让选择器出现空白项）：
            //    `bareName` → `name` → 裸 `model`。
            //
            // ⚠️⚠️ **`bareName` 优先**（不是 `name` 优先）—— 这一条与设计文档 §3.5.4.3
            //    里写的「entry.name → entry.bareName」**相反**，以本节为准。证据：
            //    - `bareName` 的**存在意义**就是「`resolveModel` 用的裸名」（见其字段注释）；
            //    - 设计文档**自己的验收表**也写「`bareName` 仅 raccoon / loomy 有；
            //      断言 `resolveModel().name` **不含 ` · x`**」；
            //    - 现有实现逐字如此：`loomy` 用 `splitLoomyRate(entry.name).name`、
            //      `raccoon` 用 `entry.name.replace(/ · .*$/, '')`；
            //    - ⚠️ 而 `minimax` **不剥**（`entry?.name ?? model`）⇒ 它**不提供**
            //      `bareName`，于是自然回退到 `name`。
            //    ⇒ 若按「name 优先」实现，loomy/raccoon 的 `resolveModel().name` 会**带上
            //      倍率后缀**，被 `loomy-adapter.spec.ts` 的「name 不带倍率」用例当场抓住
            //      （本 Task 实测：`expected 'Spark X2.5 · x0.1' to be 'Spark X2.5'`）。
            const resolved = {
                provider,
                id: model,
                name: entry?.bareName ?? entry?.name ?? model,
            };
            if (entry !== undefined) {
                if (entry.inputModalities !== undefined) {
                    resolved.inputModalities = entry.inputModalities;
                }
                if (entry.description !== undefined)
                    resolved.description = entry.description;
            }
            else {
                // ⚠️ **未知 id**：由各家自己的判据决定（见 `unknownModelInputModalities`）。
                // 骨架**不替各家决定** —— 两个方向统一都会出真缺陷：统一成「省略」会让用户
                // 手填的未知模型从「明确不支持图片」变成「未知」（用户以为能发图）；
                // 统一成 `['text']` 则会让**故意省略**的家失去「未知」这个第三态。
                // ⇒ 家数**只在上面那个接口字段的表格里维护**，这里**刻意不抄数字**
                // （原先抄了个「10 家」并写成只有 `buddy` 省略，与那张表**互相矛盾**，
                // 正是「同一事实写多处 ⇒ 必有一处先腐坏」）。
                const unknownModalities = config.unknownModelInputModalities?.();
                if (unknownModalities !== undefined)
                    resolved.inputModalities = unknownModalities;
            }
            // ⚠️ 未知模型**不编造** context（宁可让 DSH 用默认值，也不报一个假窗口）。
            if (entry?.contextWindow !== undefined && entry.contextWindow > 0) {
                resolved.context = { contextWindow: entry.contextWindow };
            }
            // ⚠️ 非法值必须过滤：0/负数/NaN 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS，
            // **整轮对话起不来**（不是降级，是崩）。
            const maxTokens = entry?.maxTokens;
            if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
                resolved.defaultMaxTokens = maxTokens;
            }
            // ⚠️ `efforts` 非空才声明；且 `defaultEffort` **必须落在 `efforts` 内** ——
            // 指向不存在的档位会让选择器显示空白，比不给更糟（DSH 会抛
            // UNSUPPORTED_REASONING_EFFORT）。
            const reasoning = entry !== undefined ? entry.reasoning : config.unknownModelReasoning?.();
            if (reasoning !== undefined && reasoning.efforts.length > 0) {
                const defaultEffort = reasoning.defaultEffort;
                const legal = defaultEffort === undefined
                    || reasoning.efforts.some((effort) => effort.id === defaultEffort);
                if (legal)
                    resolved.reasoning = reasoning;
            }
            return resolved;
        },
        /**
         * ⚠️ **同步**（契约要求，见 `ModelCatalogConfig.syncCatalog` 的说明）。
         * **不套黑名单** —— 设置页要能看到已关闭模型的倍率（用户报障：
         * 「关闭的就没有显示倍率」）。
         */
        listAllModels() {
            const source = cached ?? config.syncCatalog();
            return source.map((entry) => ({
                id: entry.id,
                name: entry.name,
                ...(entry.isFree !== undefined ? { isFree: entry.isFree } : {}),
            }));
        },
    };
}
//# sourceMappingURL=model-catalog.js.map