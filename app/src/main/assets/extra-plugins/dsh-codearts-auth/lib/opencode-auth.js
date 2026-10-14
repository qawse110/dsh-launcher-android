/**
 * 身份槽组装：把「账号池条目」+「内置匿名槽」摊平成一条**平权**的槽序列。
 *
 * ## 平权语义（设计文档 §5，用户定稿）
 *
 * 序列 = `[账号槽…（账号池手动顺序）] + [匿名槽（固定末位）]`。
 * 免费模型下全序列参与轮换；收费模型只由账号槽承载（匿名槽被剔除）。
 * 匿名殿后**只是位置，不是特权降级** —— 判据见 `pickSlot`（`opencode-adapter.ts`）。
 *
 * ## 为什么「换 PC 指纹」在这里就落不了地
 *
 * opencode CLI 发往 Zen 的请求**没有任何机器级指纹**（1.18.22 源码核对）。
 * 上游能识别的只有：出口 IP、API key、随机会话 id。
 * ⇒ 身份 = 槽：换 key（换账号）或换 proxy（换出口 IP）才是真的换身份；
 * 指纹派生做的是**防关联**与满足形状门禁，不参与配额计算。
 *
 * ## 为什么不把匿名槽也建成账号池条目
 *
 * 账号池条目要求 credentialRef 与 enabled 语义，而匿名通道无凭据可存；
 * 且它需要「不依赖任何 UI 操作恒定存在」这个性质。做成进程内合成槽更贴合。
 */
import { randomBytes } from 'node:crypto';
import { OPENCODE } from './opencode-product.js';
import { deriveProjectId, normalizeProxy, } from './opencode.js';
/** 匿名槽的固定 id（与账号池 id 空间隔离，不可能撞）。 */
export const ANONYMOUS_SLOT_ID = 'anonymous';
/** 新账号的初始指纹。 */
export function newAccountFingerprint(apiKey) {
    return { projectId: deriveProjectId(apiKey, 0), generation: 0 };
}
/**
 * 轮换到下一代指纹。
 *
 * ⚠️ **返回新对象**而不是就地改：调用方（RPC）常把旧指纹留在内存快照里，
 * 就地改会让已持有的引用提前变成新代次（写单测时实测到过）。
 *
 * ⚠️ project id 用**上一代的 projectId** 作 identity 派生，而非原始 key ——
 * 本函数不持有 key（调用方可能只有代次），这样仍能保证「代次 +1 ⇒ 指纹变化」。
 */
export function nextFingerprintGeneration(current) {
    const generation = Number.isSafeInteger(current.generation) && current.generation >= 0
        ? current.generation + 1
        : 1;
    return { projectId: deriveProjectId(current.projectId, generation), generation };
}
/**
 * 摊平为平权槽序列。
 *
 * ## 匿名槽的身份（2026-10-02 起为**池内条目**，不再是进程内合成）
 *
 * 早期实现把匿名通道做成「进程内固定合成的末位槽」—— 它恒定存在、不需任何
 * UI 操作，但**也因此不能添加、不能配代理、不能排序**，用户拿不到「多条匿名
 * 通道各走各的出口」这个能力。
 *
 * 现在匿名通道是**账号池里的一条普通条目**（`api_key === 'public'`），
 * 于是拖拽排序 / 停用 / 删除 / 代理配置 / 指纹代次全部复用既有机制。
 * 「零账号也能用」由 {@link ensureDefaultAnonymousSlot} 在首次启用时补一条
 * 默认条目来保证。
 *
 * ## ⚠️ 指纹 identity 不能用 `api_key`（匿名槽全都等于 `public`）
 *
 * 多个匿名槽的 api_key 完全相同，若用它派生 project id，N 个匿名槽会拿到
 * **同一个指纹**（彼此无法区分，且和真实 PC 伪装无关）。故：
 * - 匿名槽：`identity = entry.id`（账号池条目 id，形如 `opencode-anon-xxxx`）
 * - 账号槽：`identity = api_key`
 *
 * ⚠️ 顺带说明这个能力**不增加配额**：匿名通道按**出口 IP** 限额（实测：换 key、
 * 换任意伪装头、换指纹全部无效）。指纹分离的价值是**防关联**；配额扩容只靠
 * **给不同匿名槽配不同代理**（不同出口 IP = 不同配额桶）。面板文案按此口径。
 *
 * @param entries 账号池条目（调用方保证已按手动顺序排好）。
 * @param userAgent 覆盖 UA（通常为真机 `opencode --version` 的结果）。
 */
export function listIdentitySlots(entries, userAgent) {
    const slots = [];
    for (const entry of entries) {
        if (!entry.enabled)
            continue;
        // ⚠️ 非法代理**降级为直连并继续**：用户可能只是临时填了个错地址，
        // 不该让整个 provider 的所有账号都发不出请求（那比「悄悄走了直连」
        // 更难排查 —— 用户会看到「明明配了代理却好像没走」）。
        const normalized = entry.proxy === undefined || entry.proxy.trim().length === 0
            ? undefined
            : normalizeProxy(entry.proxy);
        const anonymous = isAnonymousCredential(entry.apiKey);
        slots.push({
            id: entry.id,
            kind: anonymous ? 'anonymous' : 'account',
            apiKey: entry.apiKey,
            proxy: normalized !== undefined && normalized.ok ? normalized.proxy : undefined,
            // ⚠️ 缺指纹时走 **`poolEntrySnapshot`（唯一实现）**，不要在这里写第二份
            //    `identity = anonymous ? entry.id : entry.apiKey` + `deriveProjectId`：
            //    那个规则的唯一权威在 `poolEntrySnapshot`，两处各写一份会分叉，
            //    而分叉的表现只是「多个匿名通道指纹相同」—— **不报错**。
            //    这里的 `enabled: true` 是**冗余**的（上一层已 `continue` 掉停用的），
            //    显式写出以免读者以为这里也会被过滤。
            fingerprint: entry.fingerprint ?? poolEntrySnapshot({
                id: entry.id,
                apiKey: entry.apiKey,
                enabled: true,
            }).fingerprint,
            userAgent,
        });
    }
    return slots;
}
/** 该凭据是否为匿名通道（字面量 `public`）。 */
export function isAnonymousCredential(apiKey) {
    return apiKey === OPENCODE.anonymousKey;
}
/**
 * 规范化指纹代次：非有限值 / 非正数一律回落 **0**（= 用凭据派生的初始指纹）。
 *
 * ⚠️ **这是唯一实现**，账号池的读取方法与槽组装都必须调它。
 * 两处各写一份 `?? 0` 会在「负数 / NaN」上分叉：`-1` 能过 `?? 0`
 * （它不是 nullish），于是轮换按钮把代次写成负数时，一处当 0、一处当 -1，
 * 产出的 project id 不同 ⇒ 同一账号在两条路径上指纹不一致。
 */
export function normalizeOpencodeGeneration(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
/**
 * 组装槽需要的**账号池条目投影**（`listIdentitySlots` 的输入单元）。
 *
 * ## 为什么必须抽成函数
 *
 * 这段派生有**两个调用方**：`apply()` 里注册真实适配器的接线块，与探测路径
 * （重测按钮）。两处若各写一份 identity 选择 + `deriveProjectId`，就会成为
 * 「同一语义两处实现」——而本仓库已有实测教训：**分叉的一侧没有用例挡**。
 * 尤其是 identity 选择（匿名槽用条目 id、账号槽用 api_key），
 * 写错只是让多个匿名通道拿到同一个指纹，**不报错**。
 *
 * @param source.id        池条目 id。
 * @param source.apiKey    解析后的 API key。
 * @param source.enabled   缺省 **true**。⚠️ 探测路径必须**依赖这个缺省**：
 *   `listIdentitySlots` 会跳过 `enabled === false` 的条目，而探测的既定语义是
 *   「停用账号也要能重测」（见 `account-probe.ts` 模块头的第 2 条设计）。
 *   若探测也照抄池里的 `enabled`，停用账号的重测会退化成「没有可用通道」。
 * @param source.proxy     池字段权威值（`opencodeProxy`）；空/缺省 = 直连。
 * @param source.generation 池字段权威代次（`opencodeFingerprintGeneration`）。
 */
export function poolEntrySnapshot(source) {
    const generation = normalizeOpencodeGeneration(source.generation);
    // ⚠️ identity 选择：匿名槽的 api_key 全是 `public`，用它派生会让 N 条匿名
    //    通道拿到**同一个指纹**（彼此无法区分）。故匿名槽改用**条目 id**。
    const identity = isAnonymousCredential(source.apiKey) ? source.id : source.apiKey;
    return {
        id: source.id,
        enabled: source.enabled ?? true,
        apiKey: source.apiKey,
        proxy: source.proxy,
        fingerprint: { projectId: deriveProjectId(identity, generation), generation },
    };
}
/**
 * 首次启用时保证至少有一个匿名通道（幂等）。
 *
 * ⚠️ 判据是「池里一条匿名条目都没有」—— **不是**「没有账号」：
 * 用户若主动删光匿名通道，那就是明确的选择，不该每次启动又给他塞回来
 * （那会让「删除」按钮看起来失灵）。
 *
 * ⚠️ 幂等且吞异常：它在 `apply()` 的启动路径上被调用，失败不能拖垮插件启动。
 *
 * @returns 新建的条目 id；已有匿名槽或新建失败时返回空串。
 */
export async function ensureDefaultAnonymousSlot(addEntry, writeCredential, listEntries, alreadyHasAnonymous) {
    try {
        if (alreadyHasAnonymous())
            return '';
        const id = `${OPENCODE.id}-anon-${randomBytes(3).toString('hex')}`;
        const refName = `OPENCODE_ANON_${randomBytes(4).toString('hex').toUpperCase()}`;
        await writeCredential(refName, JSON.stringify({
            api_key: OPENCODE.anonymousKey,
            nickname: '匿名通道',
        }));
        await addEntry({
            id,
            provider: OPENCODE.id,
            nickname: '匿名通道',
            enabled: true,
            credentialRef: refName,
            // 匿名通道没有凭据可续期 ⇒ 不能标 true（那是不实承诺，UI 会显示「可自动续期」）。
            refreshable: false,
            createdAt: Date.now(),
        });
        return id;
    }
    catch {
        // 启动路径上不抛：没有默认匿名槽只是少一条通道，用户仍可手动添加。
        return '';
    }
}
//# sourceMappingURL=opencode-auth.js.map