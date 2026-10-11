/**
 * Jet Hub「自动」适配器 —— 一个模型名用整池，按临期优先。
 *
 * ## 它解决什么
 *
 * 对标 OmniRoute 的 `auto`：模型选择器里只挂一个 `jet-hub-auto/auto`，请求进来时现场
 * 从多个 provider 的账号池里挑「积分最快作废」的那个 provider 发出去。临期的先烧、
 * 长期的留着 —— 这正是用户要的「当天/临期过期的优先使用」。
 *
 * ## 为什么只选 provider、不选账号
 *
 * 每个 provider 的适配器**自己**就会按临期/限流在它的账号间轮转（buddy/loomy 走
 * `*-balance-selector`，其余走 `getAvailableAccount` + 429 换号）。auto 若再替它们
 * 选账号，等于把同一件事做两遍、还要往账号池里塞「强制账号」的旁路（易与手动顺序、
 * 永久积分锁定打架）。所以 auto 只做**跨 provider** 的那一层：谁最快作废用谁。
 *
 * ## 临期判据（每个 provider 折算成一个「最早失效时刻」，升序取最小）
 *
 * | provider | 有可用余额时的失效时刻 |
 * |---|---|
 * | codearts | **`Infinity`（长期）** —— 接口不下发到期时间，见下 |
 * | loomy | 有今日赠送 → 当日 24:00；只剩永久 → Infinity |
 * | zcode | 各桶 `expiresAt` 的最小值；无桶但有可领 → 当日 24:00 |
 * | buddy / workbuddy | 有效资源包 `deductionEndTime` 的最小值 |
 *
 * ⚠️⚠️ **codearts 一栏已从「当日额度，UTC+8 当日 24:00」改为「长期（Infinity）」**
 * （2026-10-07，用户报障）。旧口径是**臆造**：实测 `statistics/plugin` 对资源包的
 * `cycleStartTime` / `cycleEndTime` / `expiredTime` **三个字段全为空**
 *（`codearts-credits.ts` 的注释也写明「不下发……不臆造一个到期时间」），
 * 而官方文档说的是签到积分「自发放起 30 天内有效」—— 两者都不是「今天 24:00」。
 * 后果是 codearts 在排序里**永远排最前**，抢走真正临期的额度。
 * 详见 `aggregate-expiry.ts` 的 `codeArtsExpiry` 注释。
 *
 * 只有永久/长期积分的 provider 折算成 `Infinity`（排最后，但不剔除 —— 没有临期号时
 * 仍要用它）。查询失败 / 无启用账号的 provider 折算成 `-1`（**剔除**，不参与排序）。
 *
 * ## 缓存与失效
 *
 * 一次「选 provider」的结果缓存 {@link AUTO_CHOICE_TTL_MS}（默认 60 秒，与既有余额
 * 缓存同量级）：跨 provider 的余额探测有网络成本，每分钟一次足够。⚠️ 这不破坏
 * 「临期优先」的语义 —— 一分钟内积分不会凭空作废；而 provider **内部**换号不受本
 * 缓存影响（那是各适配器每次请求现做的）。
 *
 * @module src/auto-adapter.ts
 */
import { LlmAdapter, LlmError, ReasoningEffortId, contentHasImage } from '@deepseek-ai/dsh-llm';
import { registerAdapterIdempotent } from './llm-register-compat.js';
import { translateReasoningEffort } from './reasoning-ladder.js';
// ⚠️ 选型口径的**唯一权威**是 `aggregate-core.ts`（哨兵语义 / 排序 / 倍率解析）；
// 本文件与 `aggregate-adapter.ts` 都只是它的调用方 —— 抽出原因（本仓库对「同一
// 语义两套实现」的红线）与全部真实缺陷记录见该文件模块头。**不要**在本文件另写一份。
import { UNUSABLE, pickSoonestProvider, priceFactorFromName } from './aggregate-core.js';
export { pickSoonestProvider, priceFactorFromName } from './aggregate-core.js';
// 「目标收下请求却零输出」的判据与目标级冷却（issue IKJW31 的 B 方案）。
// ⚠️ 判据的**唯一权威**在那个模块（纯函数、零 IO）；本文件只负责接线。
import { emptyZeroOutputProbe, isTargetCoolingDown, isZeroOutputWallHit, noteChunk, noteZeroOutputHit, zeroOutputKey, ZERO_OUTPUT_COOLDOWN_MS, } from './zero-output-guard.js';
// ⚠️ 临期折算的**唯一权威**是 `aggregate-expiry.ts`：本文件的 `expiryOf` 只是它的
// **薄委托**（只提供 auto 的取号方式）。四个 `*Expiry` 折算函数 Task 7 已**搬移**到
// 那里（不是复制）—— 两份同义实现必然漂移（AGENTS.md 首条判据的静默失效）。
import { createExpiryProbe } from './aggregate-expiry.js';
/** 注册到 ctx.llm 的 provider 路由，也是 providerInfo().id（DSH 校验二者相等）。 */
export const AUTO_PROVIDER = 'jet-hub-auto';
/** 对外的唯一模型名。 */
export const AUTO_MODEL = 'auto';
/** 一次跨 provider 选型的缓存时长（毫秒）。 */
export const AUTO_CHOICE_TTL_MS = 60_000;
/**
 * v1 接入的 provider（顺序即「并列最早失效时」的兜底优先级）。
 *
 * 其余 provider（qoder / trae / cline / …）结构上留好接口但不接入：它们没有跨账号
 * 的到期余额探测端点，接进来只能算成 Infinity 永远垫底，不如先不放。
 */
export const AUTO_PROVIDERS = ['codearts', 'loomy', 'zcode', 'buddy', 'workbuddy'];
/** auto 适配器对外只挂一个模型；真实能力在选型后从目标 provider 借用。 */
const AUTO_MODEL_INFO = {
    provider: AUTO_PROVIDER,
    id: AUTO_MODEL,
    name: 'Auto（临期优先 · 整池）',
    description: '自动选择积分最快作废的 provider，把临期额度先用掉。',
    inputModalities: ['text', 'image'],
};
/** Jet Hub 自动适配器。 */
export class AutoAdapter extends LlmAdapter {
    ctx;
    options;
    /** 缓存的一次选型结果（含计算时刻）。 */
    cached;
    /** 缓存的「auto 借用目标能力」的元数据（与 choice 同生命周期）。 */
    cachedInfo;
    /**
     * 惰性建的临期探针（**复用同一实例** ⇒ 折算缓存跨调用生效）。
     *
     * ⚠️ 旧实现在 `expiryOf` 里每次新建 ⇒ 缓存永不命中 ⇒ 每次请求都重打上游。
     */
    expiryProbeInstance;
    /**
     * 「目标收下请求却零输出」的目标级冷却表（issue IKJW31 的 B 方案）。
     *
     * ⚠️ **纯内存、进程内、不落盘**：它优化的是「本次运行内别再三连撞同一堵墙」，
     * 重启后重新试探是**正确**行为 —— 用户可能已升级插件、上游可能已扩容，
     * 落盘只会让一次误判跨重启生效。
     * ⚠️ 语义与账号池的 `modelRateLimits` **不同**：那些记在**账号**上，本表记在
     * **目标**（provider + model）上 —— 越墙换账号无用（账号无关），换目标才有用。
     */
    zeroOutputCooldowns = new Map();
    constructor(ctx, options) {
        super();
        this.ctx = ctx;
        this.options = options;
    }
    providerInfo(provider) {
        return { id: provider, name: 'Jet Hub 自动（临期优先）' };
    }
    /** 目录里永远只有一个 auto（真实模型由选型决定，不在此暴露）。 */
    async listModels() {
        return [AUTO_MODEL_INFO];
    }
    /**
     * 解析 `auto` 的能力元数据。
     *
     * 尽量借用「当前选型目标」的真实 context / 档位（让 harness 的请求校验贴近实际），
     * 但**身份必须改回 auto**：DSH 的 `normalizeModelInfo` 会拒掉 provider/id 与请求
     * 路由不符的元数据。选型不可用时退回到一份保守的通用元数据（不声明档位，任何
     * reasoningEffort 都会被 harness 判为不支持 —— 故这里连 reasoning 字段都不带）。
     */
    async resolveModel() {
        const resolved = await this.ensureChoice();
        if (resolved?.info !== undefined) {
            // ⚠️ 身份必须改写回 auto（真实缺陷修复）：DSH 的 normalizeModelInfo 拒绝
            // provider/id 与请求路由不符的元数据 —— 直接返回目标的 info 会让目录加载报
            // INVALID_MODEL_INFO。能力（context / 档位）保留目标那份。
            // ⚠️ inputModalities 必须恒为 text+image（真实缺陷修复 #2，用户报障
            // 「怎么又不支持图片了」）：宿主**附加图片前**按这里判，而借用的目标 info
            // 可能缺失该字段（如 loomy 的 resolveModel 不声明）—— 缺失会被宿主当
            // 「不支持」，于是带图消息在选择器阶段就被拦。auto 是整池，池里有能看图的
            // provider，声明如实；「这次选中的目标收不收得了图」由 stream 闭包改道保证。
            return {
                ...resolved.info,
                provider: AUTO_PROVIDER,
                id: AUTO_MODEL,
                inputModalities: ['text', 'image'],
            };
        }
        return {
            provider: AUTO_PROVIDER,
            id: AUTO_MODEL,
            name: AUTO_MODEL_INFO.name,
            ...(AUTO_MODEL_INFO.description === undefined ? {} : { description: AUTO_MODEL_INFO.description }),
            inputModalities: ['text', 'image'],
            context: { contextWindow: 200_000 },
        };
    }
    /**
     * 绑定「一次选型」到本次分发。
     *
     * 返回的 `stream` 闭包把请求改写为目标 provider/model 后交给 `ctx.llm.stream` ——
     * 走公开路径，目标适配器照常做它自己的选号 / 限流换号 / 续期。
     *
     * ## 图片感知选型（真实缺陷修复：为什么不能只用 ensureChoice 的缓存）
     *
     * 对外 auto 声明支持图片（整池里有能看图的 provider，声明纯文本会让宿主在
     * **进入请求前**就拒绝带图消息 ——「当前模型不支持图片」正是这样来的）。
     * 但**临期胜者不一定能看图**（如 codearts 的模型全是纯文本）。故这里在分发时
     * 检查本次消息是否真的带图：带图而胜者不支持 → 改发「支持图片的 provider 里
     * 临期最早」的那个。无图请求完全不受影响，仍走 60 秒缓存。
     *
     * ⚠️ 覆盖目标用 `llm.stream`（公开路径）而非「再挑一个模型直接发给它的适配器」：
     * 只有走公开路径，目标适配器的选号 / 续期 / 限流换号才全部照常生效。
     */
    async prepareCall(_provider, _model, signal) {
        const resolved = await this.ensureChoice(signal);
        if (resolved === undefined) {
            throw new LlmError('jet-hub-auto: 没有任何已登录且可用的 provider 账号。请先在 Jet Hub 面板登录至少一个（codearts / loomy / zcode / CodeBuddy / WorkBuddy）。', 'MISSING_CREDENTIAL');
        }
        let { choice, info } = resolved;
        // 请求需要图片吗？（与宿主 capability 判据同一函数：含 tool-result 递归。）
        // prepareCall 拿不到完整消息（它只有 provider/model），带图判定发生在 stream
        // 闭包里 —— 那里才拿得到 options.messages。见下方闭包内的二次检查。
        const imageCapable = info?.inputModalities?.includes('image') === true;
        if (!imageCapable) {
            // 目录元数据缺失或声明纯文本：先按无缓存决策继续，真正带图时由 stream
            // 闭包里的 imageFallback 兜底改道。
            this.ctx.logger?.warn?.(`[jet-hub-auto] 临期胜者 ${choice.provider}（${choice.model}）可能不支持图片；`
                + '带图请求将自动改道到支持图片的 provider');
        }
        // ⚠️ 预解析**两个**转发目标（prepareCall 是异步的，闭包必须保持同步签名 ——
        // `PreparedAdapterCall.stream` 的契约是「同步返回 AsyncIterable」）：
        // ① 临期胜者（正常路径）；② 胜者不能收图时的「支持图片且临期最早」目标。
        // 两者的思考档位也在这里一并解析（见 {@link DispatchTarget.efforts}）。
        const mainTarget = await this.dispatchTargetOf(choice, signal);
        let imageTarget = null;
        if (!imageCapable) {
            const entries = [];
            for (const provider of AUTO_PROVIDERS) {
                if (provider === choice.provider)
                    continue;
                if (!(await this.providerSupportsImages(provider)))
                    continue;
                let expiry = await this.expiryOf(provider, signal);
                // 目录空/模型全关 ⇒ 该 provider 不可调用，不能当改道目标（PR !69 审计实测）。
                const model = await this.firstModelOf(provider);
                if (model === undefined) {
                    expiry = UNUSABLE;
                }
                else if (!await this.hasUsableAccountFor(provider, model, signal)) {
                    // ⚠️⚠️ **改道路径同样要按将要派发的模型复核可用性**（真实缺陷，2026-10-07
                    //    独立审计实测证伪 —— 同型缺陷的**第三处实例**）。
                    //
                    // 主选型路径（`selectProvider`）已补该复核，但**改道路径原先漏了**：
                    // 一个「支持图片但额度已尽」的渠道仍会被选成 imageTarget ⇒ 带图请求
                    // 发出去必然失败。可达性真实：buddy 既声明 `['text','image']`
                    //（`buddy-adapter.ts:1272`）**又**会写 `modelRateLimits`（`:1922`）。
                    //
                    // ⚠️ 同一缺陷在本文件已修过主路径、在 `aggregate-adapter.ts` 修过建池路径
                    //    —— 这是第三处。**修同型缺陷时必须把同一文件里的所有实例一起找出来**，
                    //    否则就会留下这种「修了一处、漏了另一处」。
                    expiry = UNUSABLE;
                }
                entries.push([provider, expiry]);
            }
            const picked = pickSoonestProvider(entries);
            if (picked !== undefined) {
                const model = await this.firstModelOf(picked);
                if (model !== undefined) {
                    imageTarget = await this.dispatchTargetOf({ provider: picked, model }, signal);
                }
            }
        }
        return {
            // 身份必须是 auto（DSH 校验），能力取自目标。
            // ⚠️ `name` 带上**实际选中的 provider**：这是「选型降级」唯一的用户可见
            // 提醒 —— 临期额度被关闭/用尽后 auto 会换到谁，直接显示在模型选择器里，
            // 不必去翻日志（静默降级正是本仓库反复修过的那类缺陷）。
            // ⚠️ inputModalities 恒为 text+image（整池诚实声明）：宿主据此放行带图消息，
            // 真正「这次能不能收图」由 stream 闭包里的改道保证，而不是在这里掐死。
            model: {
                ...(info === undefined ? await this.resolveModel() : info),
                provider: AUTO_PROVIDER,
                id: AUTO_MODEL,
                name: `Auto（临期优先）· ${choice.provider}`,
                description: `自动选择积分最快作废的 provider；本次选中 ${choice.provider}（模型 ${choice.model}）。`,
                inputModalities: ['text', 'image'],
            },
            stream: (options) => {
                // 带图判定在闭包里做：只有这里拿得到 options.messages（与宿主
                // capability 判据同一函数 contentHasImage，含 tool-result 递归）。
                const hasImage = options.messages.some((message) => contentHasImage(message.content));
                if (hasImage && !imageCapable) {
                    if (imageTarget === null) {
                        // 全池都不支持图片：如实报错而不是把图降级成文字占位 —— 后者会让
                        // 模型「看到一张图被抹掉」却不知道用户发了什么，属静默丢数据。
                        throw new LlmError('jet-hub-auto: 本次请求带图片，但池内所有已登录 provider 都不支持图片输入。'
                            + '请换一个支持图片的模型，或去掉图片后重试。', 'INVALID_REQUEST');
                    }
                    // 带图而胜者不能收图 → 改道（这是**本次请求**的能力需求，不走选型缓存）。
                    this.ctx.logger?.warn?.(`[jet-hub-auto] 带图请求：临期胜者 ${choice.provider}（${choice.model}）不支持图片，已改道到 ${imageTarget.provider}（${imageTarget.model}）`);
                    return this.dispatch(imageTarget, options);
                }
                return this.dispatch(mainTarget, options);
            },
        };
    }
    /**
     * 解析一个转发目标：**连同该模型声明的思考档位**。
     *
     * 档位必须在这里取（而非分发时）—— `stream` 闭包是同步的，而取档位要
     * `await resolveModelInfo`。解析失败按「无档位」处理（转发时不下发该字段），
     * 不影响其余能力。
     */
    async dispatchTargetOf(choice, signal) {
        try {
            const info = await this.ctx.llm.resolveModelInfo(choice.provider, choice.model, signal);
            const efforts = (info.reasoning?.efforts ?? [])
                .map((effort) => String(effort.id))
                .filter((id) => id.length > 0);
            return { ...choice, efforts };
        }
        catch {
            return { ...choice, efforts: [] };
        }
    }
    /**
     * 按目标 provider 转发一次请求，**先翻译思考档位**；并观测「收下请求却零输出」
     * 的失败形态，命中时**顺位改道下一个 provider 重发一次**（issue IKJW31 的 B 方案）。
     *
     * ## 为什么要翻译档位（真实缺陷，用户报障 2026-10-05）
     *
     * auto 借用的 `reasoning.efforts` 来自**本次选中的目标模型**（如 zcode 的
     * `low` / `high` / `max`），但请求里的 `reasoningEffort` 是 harness 依据
     * **上一次对话**留下的值，可能带着**别的模型族**的档位名（如 TRAE 的
     * `xhigh`、LobsterAI 的 `light`）。原样转发会被 DSH 按 id 严格校验拦下：
     *
     * ```
     * provider "zcode" model "GLM-5.3-Flash" does not support reasoning effort "xhigh"
     *   UNSUPPORTED_REASONING_EFFORT
     * ```
     *
     * 改道（带图）或换号后同理 —— 目标换了，档位语义也就跟着变。
     *
     * 修法复用仓库既有的 {@link translateReasoningEffort}（本网关
     * `openai-gateway/messages.ts` 一直在用同一套口径）：
     * - `exact` → 原样下发；
     * - `mapped` → 就近落到目标声明的同族档位（**同距取更强**，与仓库口径一致）
     *   并记一条 warn —— 这是「静默降级」与「静默改语义」之间唯一的区别；
     * - `unexpressible` → 目标根本没这一族（如要 `off` 而它只声明 `high`）→ **不
     *   下发**该字段（让上游走它自己的默认），而不是硬塞一个错的；
     * - `unknown` → 请求值是未登记的怪名字，**删掉该字段**并 warn：让上游按默认
     *   走，比抛错打断整轮对话更可取（用户改个档位不该让整个任务失败）。
     *
     * ## ★ 零输出撞墙的改道（B 方案）
     *
     * 判据在 `zero-output-guard.ts`（**唯一权威**）：`max-tokens` **且零输出**。
     * ⚠️ 必须同时要求零输出 —— 有输出的 `max-tokens` 是「正常答到半截撞了输出
     * 上限」，那时换目标会**丢掉已产出的正文**（与 `aggregate-adapter.ts` 的
     * 「已吐内容就不许切换」是同一个安全方向）。
     *
     * ⚠️ **已透出帧的处理**：零输出意味着 `textDelta` 从未出现，而
     * `block-start` 只在有内容时才发（`openai-compat.ts:740-746`）⇒ 这一轮唯一
     * 可能已透出的只有 `usage` 帧，而它对 `BlockAssembler` 是**覆盖式**赋值
     * ⇒ 重发安全。故这里**不必缓冲整个流**（那会把透传改成带前瞻的缓冲，属更大的
     * 改动面，与 `aggregate-adapter.ts` 里「延迟 block-start」那条已知代价同类）。
     * 一旦某天有适配器在零内容时也发 `block-start`，本条注释的前提即失效 ——
     * 那时必须先缓冲再改道。
     */
    async *dispatch(target, options, 
    /** 本次请求内已撞过墙、不得再选的目标（递归传递，避免无限改道）。 */
    exclude = new Set()) {
        const requested = options.reasoningEffort;
        const base = { ...options, provider: target.provider, model: target.model };
        const forwarded = this.withTranslatedEffort(target, base, requested);
        let probe = emptyZeroOutputProbe();
        for await (const chunk of this.ctx.llm.stream(forwarded)) {
            probe = noteChunk(probe, chunk);
            // ⚠️ 判定必须在**透出该终止帧之前**：一旦把 `max-tokens` 交给 harness，
            //    本轮就结束了（DSH 对 `max-tokens` 不自动重试），改道机会随即消失。
            if (chunk.type === 'finish' && isZeroOutputWallHit(probe)) {
                const next = await this.replaceAfterZeroOutput(target, options, exclude);
                if (next !== undefined) {
                    // 记冷却（跨请求）：否则下一个请求仍会撞同一堵墙（60 秒选型缓存）。
                    this.zeroOutputCooldowns = noteZeroOutputHit(this.zeroOutputCooldowns, target.provider, target.model, this.now());
                    const nextExclude = new Set(exclude);
                    nextExclude.add(zeroOutputKey(target.provider, target.model));
                    this.ctx.logger?.warn?.(`[jet-hub-auto] ${target.provider}（${target.model}）收下请求却零输出`
                        + `（疑似声明窗口虚高，如 loomy 的 spark-x 曾虚报 1M），`
                        + `已改道到 ${next.provider}（${next.model}）重发；`
                        + `该目标在 ${Math.round(ZERO_OUTPUT_COOLDOWN_MS / 60_000)} 分钟内不再被选`);
                    yield* this.dispatch(next, options, nextExclude);
                    return;
                }
                // 没有下一个候选：**如实透出**这轮的终止帧（不吞掉失败、不伪造成功）。
                this.ctx.logger?.warn?.(`[jet-hub-auto] ${target.provider}（${target.model}）收下请求却零输出，`
                    + `但池内已无其他候选可改道；如实上报该失败`);
            }
            yield chunk;
        }
    }
    /**
     * 零输出撞墙后顺位选下一个目标；无候选时返回 `undefined`。
     *
     * ⚠️ 复用 {@link selectProvider}（**同一套临期/可用性/冷却判据**）而不是在这里
     * 另写一份「挑下一个」—— 那会是同一语义两套实现（本仓库红线），且必然漂移。
     */
    async replaceAfterZeroOutput(current, options, exclude) {
        const nextExclude = new Set(exclude);
        nextExclude.add(zeroOutputKey(current.provider, current.model));
        const picked = await this.selectProvider(options.signal, p => this.firstModelOf(p), nextExclude);
        if (picked === undefined)
            return undefined;
        // 选回自己（同 provider 同 model）没有意义 —— 那会立刻再撞一次同一堵墙。
        if (picked.provider === current.provider && picked.model === current.model)
            return undefined;
        // ⚠️ 必须经 `dispatchTargetOf` 解析**新目标的档位**：换目标后档位语义跟着变，
        //    直接把 `AutoChoice` 当目标用会漏掉翻译（编译期就拦住了，见本行）。
        return await this.dispatchTargetOf(picked, options.signal);
    }
    /**
     * 按目标档位表翻译 `reasoningEffort`，返回可交给 `ctx.llm.stream` 的选项。
     *
     * ⚠️ 抽成独立方法是为了让 `dispatch` 的观测/改道逻辑与档位翻译**分开**：
     * 后者是纯函数式的选项改写（既有行为，逐字节不变），前者是新增的失败恢复。
     */
    withTranslatedEffort(target, base, requested) {
        if (requested === undefined)
            return base;
        const requestedEffort = String(requested);
        const declared = target.efforts;
        if (declared.length === 0) {
            // 目标不声明任何档位：不下发（否则 DSH 会报 UNSUPPORTED_REASONING_EFFORT）。
            this.ctx.logger?.warn?.(`[jet-hub-auto] ${target.provider}（${target.model}）未声明思考档位，已忽略请求的「${requestedEffort}」`);
            return { ...base, reasoningEffort: undefined };
        }
        const mapped = translateReasoningEffort(requestedEffort, declared);
        if (mapped.kind === 'exact')
            return base;
        if (mapped.kind === 'mapped') {
            this.ctx.logger?.warn?.(`[jet-hub-auto] ${target.provider}（${target.model}）没有档位「${requestedEffort}」，已就近改为「${mapped.effort}」`);
            return {
                ...base,
                reasoningEffort: ReasoningEffortId(mapped.effort),
            };
        }
        // unexpressible / unknown：不下发该字段，让上游走自己的默认。
        this.ctx.logger?.warn?.(`[jet-hub-auto] ${target.provider}（${target.model}）无法表达档位「${requestedEffort}」（${mapped.kind}），本次按上游默认发送`);
        return { ...base, reasoningEffort: undefined };
    }
    /** 注入的当前时刻（与选型缓存共用同一时钟，便于单测控制冷却边界）。 */
    now() {
        return this.options.now?.() ?? Date.now();
    }
    /**
     * 该 provider 的目录里是否存在**未被彻底关闭**且支持图片的模型。
     *
     * 读各适配器 `listModels()` 播报的 `inputModalities`（它内部已应用隐藏/关闭表），
     * 不看账号余额 —— 余额是 {@link expiryOf} 的事，这里只回答「能不能收图」。
     */
    async providerSupportsImages(provider) {
        try {
            const models = await this.ctx.llm.listModels(provider);
            return models.some((model) => model.inputModalities?.includes('image') === true);
        }
        catch {
            return false;
        }
    }
    /** auto 从不直接被 stream（总是先经 prepareCall）；兜底抛错而非静默。 */
    async *stream() {
        throw new LlmError('jet-hub-auto: 请通过模型选择器使用 auto', 'INVALID_REQUEST');
    }
    /**
     * 取选型（命中缓存直接回；否则重新探测全池）。
     *
     * 与 {@link resolveModel} / {@link prepareCall} 共用同一份缓存，保证「本轮能力」与
     * 「本轮实际发往的 provider」出自同一次决策 —— 分裂会让 harness 用 A 的能力校验、
     * 却发往 B。
     */
    async ensureChoice(signal) {
        const now = this.options.now?.() ?? Date.now();
        // ⚠️ abort 必须**立刻**以 AbortError 结束，绝不能被降级（PR !69 审计实测）。
        // 初版把 `expiryOf` 里的 `signal?.aborted` 折算成 `UNUSABLE`，于是所有 provider
        // 都被剔除 ⇒ 返回 undefined ⇒ 抛 MISSING_CREDENTIAL ⇒ 用户取消请求后看到的
        // 是「请先在 Jet Hub 面板登录至少一个」。而缓存命中分支根本不查 signal，
        // 同一个取消事件在 60 秒窗口的不同位置会产出两种完全不同的错误，极难复现。
        signal?.throwIfAborted();
        /**
         * ⚠️⚠️ 缓存命中前必须复核「该目标是否已进零输出冷却」（issue IKJW31 的 B 方案）。
         *
         * 不查的后果是**冷却形同虚设**：选型缓存 60 秒，而冷却 10 分钟 ⇒ 每个请求都会
         * 先按缓存**撞一次同一堵墙**（撞完才在 `dispatch` 里改道）。报障实测的
         * t14/t15/t16 三连撞正是这个形态 —— 而「别再撞同一堵墙」正是本方案的**全部
         * 价值**。⇒ 冷却中的缓存项**视为过期**，落到下面重新选型。
         *
         * ⚠️ 判据复用 `isTargetCoolingDown`（**唯一权威**在 `zero-output-guard.ts`），
         *    不在这里另写一份时刻比较。
         */
        const cachedChoice = this.cached;
        const cachedCooling = cachedChoice !== undefined
            && isTargetCoolingDown(this.zeroOutputCooldowns, cachedChoice.choice.provider, cachedChoice.choice.model, now);
        if (cachedChoice !== undefined && !cachedCooling
            && now - cachedChoice.at < (this.options.ttlMs ?? AUTO_CHOICE_TTL_MS)) {
            return { choice: cachedChoice.choice, info: this.cachedInfo };
        }
        const picked = await this.selectProvider(signal, choice => this.firstModelOf(choice));
        if (picked?.model === undefined) {
            this.cached = undefined;
            this.cachedInfo = undefined;
            return undefined;
        }
        const choice = { provider: picked.provider, model: picked.model };
        // 借用目标真实能力；失败不致命（resolveModel 会退回保守元数据）。
        let info;
        try {
            info = await this.ctx.llm.resolveModelInfo(choice.provider, choice.model, signal);
        }
        catch {
            info = undefined;
        }
        this.cached = { at: now, choice };
        this.cachedInfo = info;
        return { choice, info };
    }
    /**
     * 探测各 provider 的最早失效时刻并选出胜者。
     *
     * ⚠️ `modelOf` 是「该 provider 能否**实际被调用**」的判据（PR !69 审计实测）：
     * 一个 provider 余额充足、但目录为空或模型被用户全关时，仍**不能**当选 ——
     * 初版会让它拿到请求再发出一个必然 404 的模型 id。故排序时就把这类 provider
     * 当作 `UNUSABLE` 剔除，顺位让给下一个候选（而不是整体放弃 auto）。
     *
     * ## ⚠️⚠️ 还必须按 `modelOf` 返回的**真实模型**复核账号可用性（真实缺陷，2026-10-07）
     *
     * 「额度耗尽」在账号池里是**按 modelId 记账**的
     *（`entry.modelRateLimits[modelId]`；codearts 的 benefit 免费额度耗尽就写在那里，
     * `llm-adapter.ts:1290`），而折算取号用的模型键**未必等于**这里要派发的模型：
     *
     * | 消费者 | 折算取号用的键 | 实际派发 |
     * |---|---|---|
     * | `AutoAdapter` 自建探针（单测/未注入时） | `firstModelOf`（按倍率挑最便宜） | 同一个 ✓ |
     * | **生产装配**（`index.ts` 注入 `sharedExpiryProbe`） | **`models[0]?.id`** | **`firstModelOf`** ✗ |
     *
     * ⚠️ 生产装配下两者**不同**：共享探针的 `firstModelIdOf` 是「取目录第一个」
     *（见 `index.ts` 那段「共享带来的语义松弛」注释），而 `firstModelOf` 是
     * 「按倍率挑最便宜」。实测（探针，2026-10-07）：目录为
     * `[glm-5.3-flash, Deepseek-V4.1-Flash · x0.1]`、账号在 `deepseek-v4.1-flash`
     * 上额度已尽时，auto 仍选中 `codearts/deepseek-v4.1-flash` —— 因为折算问的是
     * `glm-5.3-flash`（未被标记），按 modelId 的过滤**整体失效**。
     *
     * ⚠️ 这**推翻**了 `index.ts:2210-2222` 那句「共享的松弛已核实无害」：该注释
     * 假设「`probeModel` 不参与折算结果、故与派发无关」，但它**参与账号池的
     * 限流过滤** —— 而那正是「这个模型还能不能用」的判据。故这里必须显式复核。
     */
    async selectProvider(signal, modelOf, 
    /**
     * 已尝试过、本次请求内**不得再选**的目标（`` `${provider}\u0000${model}` ``）。
     *
     * ⚠️ B 方案的改道（`stream` 闭包里的零输出重试）用它顺位换下一个 provider。
     * 默认空集 ⇒ 既有调用方行为**逐字节不变**。
     */
    exclude) {
        const now = this.options.now?.() ?? Date.now();
        const entries = [];
        for (const provider of AUTO_PROVIDERS) {
            let expiry = await this.expiryOf(provider, signal);
            if (expiry !== UNUSABLE && modelOf !== undefined) {
                // 目录空/全关 ⇒ 退出候选（不可调用），与「不可用」同等对待。
                const model = await modelOf(provider);
                if (model === undefined) {
                    expiry = UNUSABLE;
                }
                else if (!await this.hasUsableAccountFor(provider, model, signal)) {
                    // ⚠️ 该 provider 在**将要派发的那个模型**上没有可用账号（额度已尽/限流中）
                    //    ⇒ 剔除，顺位让给下一个候选。否则请求发出去必然失败。
                    expiry = UNUSABLE;
                }
                else if (exclude?.has(zeroOutputKey(provider, model)) === true) {
                    // 本次请求内已经撞过它的墙 ⇒ 顺位换下一个（B 方案）。
                    expiry = UNUSABLE;
                }
                else if (isTargetCoolingDown(this.zeroOutputCooldowns, provider, model, now)) {
                    // ⚠️ **跨请求**的目标级冷却（issue IKJW31 的 B 方案）：该目标近期
                    //    「收下请求却零输出」，在一段时间内别再选它 —— 否则 `AUTO_CHOICE_TTL_MS`
                    //    的 60 秒选型缓存会让**后续每个请求**都重新撞同一堵墙（报障实测
                    //    t14/t15/t16 三连撞正是这个形态）。
                    //
                    // ⚠️ 用既有 `UNUSABLE` 哨兵剔除（**不新造「冷却」概念**）：排序/兜底
                    //    规则因此完全复用，不必在 `pickSoonestProvider` 里加分支。
                    // ⚠️ 到期即自动解除（判据取 `until > now`）⇒ 无需清理任务，也不会
                    //    把一次误判永久固化（这是本仓库在 `refreshable` 单向门上踩过的坑）。
                    this.ctx.logger?.warn?.(`[jet-hub-auto] ${provider}（${model}）近期出现过「收下请求却零输出」`
                        + `（疑似声明窗口虚高），本次暂时跳过；到期自动恢复`);
                    expiry = UNUSABLE;
                }
            }
            entries.push([provider, expiry]);
        }
        const winner = pickSoonestProvider(entries);
        if (winner === undefined)
            return undefined;
        const model = modelOf !== undefined ? await modelOf(winner) : undefined;
        if (modelOf !== undefined && model === undefined)
            return undefined;
        return { provider: winner, model: model ?? '' };
    }
    /**
     * 该 provider 在**指定模型**上是否还有可用账号（额度未耗尽 / 未在限流中）。
     *
     * ⚠️ 判据交给账号池（`getAvailableAccount` 按 `modelRateLimits[modelId]` 过滤）
     * —— 不在这里另写一份「额度是否耗尽」的判据（那会是同一语义两套实现，
     * 本仓库对此有明确红线）。
     *
     * ⚠️ 三条边界（与 `aggregate-adapter.ts` 的 `filterByModelAvailability` **逐格同构**）：
     * - 池未实现该方法 ⇒ **视为可用**（跳过过滤）：大量既有单测桩只实现
     *   `disabledModelsFor`，判成不可用会让所有桩用例「零候选」。宁可少筛一层，
     *   不可把整池误剔除。
     * - 查询抛错 ⇒ **视为可用**：一次池查询异常不该让渠道整体消失。
     * - ⚠️ **中止必须原样逃逸**：判据取**三条**（与 `aggregate-adapter.ts` 的
     *   `isAbortLike` 同构）—— `signal.aborted` / `name === 'AbortError'` /
     *   `code === 'ABORTED'`。
     *
     *   ⚠️⚠️ **不要只判 `name`**（我上一版正是这么写的，注释还声称「同口径」，
     *   被对抗审计实测证伪）：`aggregate-adapter.ts` 的 `abortError()` 会**同时**
     *   设 `name` 与 `code`，但别的调用方可能只设 `code` —— 那时只判 `name` 会把
     *   中止**吞成「视为可用」并继续发请求**，正是本仓库反复记录的那类缺陷。
     *   （当前生产装配下该形态不可达，但「同族判据必须逐格同构」是硬要求。）
     */
    async hasUsableAccountFor(provider, model, signal) {
        const pool = this.options.accountPool;
        if (typeof pool.getAvailableAccount !== 'function')
            return true;
        signal?.throwIfAborted();
        try {
            const available = await pool.getAvailableAccount(provider, model);
            return available !== null && available !== undefined;
        }
        catch (error) {
            signal?.throwIfAborted();
            // ⚠️ 三条判据，与 `aggregate-adapter.ts:1684-1689` 的 `isAbortLike` 逐字同构。
            if (error !== null && typeof error === 'object') {
                const candidate = error;
                if (candidate.name === 'AbortError' || candidate.code === 'ABORTED')
                    throw error;
            }
            return true;
        }
    }
    /**
     * 某 provider「一个代表账号」的最早失效时刻（毫秒）。
     *
     * ⚠️ 本方法现在**委托** `createExpiryProbe`（`aggregate-expiry.ts`）—— 折算口径
     * 的**唯一权威**在那里，本处只提供 auto 的取号方式（`firstModelOf`）。
     * 早期这里是独立实现，与聚合层的探针构成两份同义逻辑；Task 7 已合并。
     *
     * 取一个启用账号做代表：它同时确认了「这个 provider 现在有没有可用账号」
     * （取不到即 UNUSABLE）。⚠️ 探测的是代表账号的余额，provider 内部换号由各适配器
     * 每次请求现做，不依赖这里。
     *
     * ⚠️⚠️ **必须带真实 modelId 取号，不能传空串**（真实缺陷，PR !69 审计实测）：
     * `getAvailableAccount` 对空 modelId 直接 `return true` 跳过限流过滤
     * （`account-pool.ts:1049-1055`），而候选顺序就是**用户的手动顺序**
     * （`:1057`）⇒ 空串取回的是「手动序第一个启用账号」，**哪怕它此刻正在限流**。
     * 本仓库在 `index.ts:598-600` 已为同一坑留下过成文警告，这里是同一个缺陷的第二实例。
     *
     * 后果是多账号池的真实场景：手动序第一个号额度已烧完（折算 `NEVER`）、第二个号还有
     * 9 天后作废的额度 ⇒ auto 只看到第一个号 ⇒ 该 provider 被判成「无临期」而排到最后，
     * **临期额度被完全忽略**，与「临期优先」的价值主张相反。
     *
     * ⇒ 委托时把 `firstModelOf` 传进去（它内部先从目录拿一个真实 modelId），
     * 让限流过滤真正生效。
     */
    async expiryOf(provider, signal) {
        // ⚠️⚠️ **必须复用同一个 probe 实例**（用户要求「排序读缓存，不每次打服务器」）。
        //
        // 旧写法 `return createExpiryProbe(pool, …)(provider, signal)` —— **每次调用都
        // 新建一个 probe** ⇒ 折算结果缓存（`EXPIRY_CACHE_TTL_MS`）**永远不会命中**，
        // 于是每次请求都对每个候选渠道重打上游余额接口。
        //
        // ⚠️ 惰性建一次（`??=`）而不是在构造器里建：构造期 `this.firstModelOf` 可能
        // 还没就绪（它是实例方法，绑定没问题，但构造期建会让「未使用 auto」的场景也
        // 持有缓存）。惰性建的语义与构造期建**等价**（同一个实例、同一份缓存），
        // 且与 `choiceCache` 的既有惰性风格一致。
        this.expiryProbeInstance ??= this.options.expiryProbe ?? createExpiryProbe(this.options.accountPool, p => this.firstModelOf(p), 
        // ⚠️ 单测可用 `ttlMs: 0` 关掉缓存（既有用例依赖「每次真探」的语义）。
        this.options.expiryTtlMs === undefined ? {} : { ttlMs: this.options.expiryTtlMs });
        return this.expiryProbeInstance(provider, signal);
    }
    /**
     * 目标 provider 里选一个**未被彻底关闭**的模型 —— **同 provider 内按倍率升序**
     * （限时折扣 / 免费优先），倍率解析自目录展示名（`Space-Bunny · x0.03` 这类，
     * 各 provider 的目录名都带；带「免费」按 0 算）。没有倍率标注的模型视为
     * `Infinity`，排在任何有标注的之后。
     *
     * ## 返回 `undefined` 的含义（真实缺陷修复，PR !69 审计实测）
     *
     * `undefined` = **该 provider 目录里没有可调用的模型**（目录为空 / 读取失败 /
     * 用户把模型全关了）。调用方必须把该 provider **退出候选**，绝不能发请求。
     *
     * ⚠️ 初版在这里回落到硬编码 `AUTO_FALLBACK_MODELS[provider]`，而触发回落的前提
     * 恰恰是「目录为空或**全被关闭**」—— 此时那个 id 正是用户明确关掉的模型。
     * 实测（真实链路探针）：用户关掉 zcode 全部模型后，auto 仍选中 zcode 并发出
     * **`zcode/auto`**（字符串 `'auto'` 被当成 zcode 的模型名）⇒ 必然 404，且请求
     * 打到了一个用户已禁用的 provider。这违反本文件自己的注释「关闭即不可调用」。
     *
     * ## 为什么按倍率选（真实缺陷，用户报障 2026-10-05）
     *
     * 原实现取目录第一个 —— CodeBuddy 目录首个是 `hy4-preview`（x0.29），而同池的
     * `Space-Bunny` 正在限时折扣（x0.03）。大任务跑了前者，等于同样的活多花约十倍
     * 积分。auto 既然定位是「省钱烧临期」，同 provider 内当然该挑最便宜的。
     *
     * ⚠️ 必须跳过被关闭的模型（`disabledModelsFor`）—— 关闭即「不可调用」，
     * auto 不能把请求路由过去。
     */
    async firstModelOf(provider) {
        const disabled = this.options.accountPool.disabledModelsFor(provider);
        let skipped = 0;
        let best;
        try {
            const models = await this.ctx.llm.listModels(provider);
            for (const model of models) {
                if (typeof model.id !== 'string' || model.id.length === 0)
                    continue;
                if (disabled.has(model.id)) {
                    skipped++;
                    continue;
                }
                const price = priceFactorFromName(model.name ?? model.id);
                if (best === undefined || price < best.price)
                    best = { id: model.id, price };
            }
            if (best !== undefined) {
                // ⚠️ 这里必须**先**记 warn 再返回：初版把 `return` 写在 warn 之前，那条日志
                // 在正常路径上永远不执行，注释「跳过不是静默降级」因此完全失真。
                if (skipped > 0) {
                    this.ctx.logger?.warn?.(`[jet-hub-auto] ${provider} 目录中的 ${skipped} 个模型已被关闭，已跳过`);
                }
                return best.id;
            }
        }
        catch (error) {
            this.ctx.logger?.warn?.(`[jet-hub-auto] ${provider} 读取模型目录失败：${String(error)}`);
            return undefined;
        }
        if (skipped > 0) {
            this.ctx.logger?.warn?.(`[jet-hub-auto] ${provider} 的 ${skipped} 个模型全部被关闭，已退出候选`);
        }
        // 目录为空 / 全被关闭：如实返回「无可用模型」，由调用方把该 provider 剔除。
        // ⚠️ 绝不能回落到硬编码 id —— 那正是用户关掉的模型（见方法注释）。
        return undefined;
    }
}
/** 在 ctx.llm 上注册 auto 路由（幂等，见 `llm-register-compat.ts`）。 */
export function registerAutoLlm(ctx, options) {
    const adapter = new AutoAdapter(ctx, options);
    registerAdapterIdempotent(ctx.llm, [AUTO_PROVIDER], adapter, message => ctx.logger?.warn?.(message));
    return adapter;
}
/**
 * 「auto 现在会选谁」——按临期判据算出当前胜者（供用量徽标等外部消费）。
 *
 * ⚠️ 与 {@link AutoAdapter.selectProvider} 是**同一套判据**（每个 provider 用
 * `getAvailableAccount` 确认可用性 + 各家余额端点折算最早失效时刻），但走的是
 * **独立实例**：徽标轮询不该与选型缓存互相踩（选型有 60 秒缓存且随请求刷新，
 * 徽标是 60 秒轮询、隐藏页跳过 —— 两者的节奏本来就该解耦）。
 *
 * ## ⚠️⚠️ 聚合 provider 的用量徽标**不用本函数**（2026-10-07 定，规格 §6.5）
 *
 * 本函数是**预测**语义（预检余额、算临期胜者），且**有自己的网络成本**。
 * 而聚合徽标取的是**真实历史** —— `AggregateAdapter` 在**实际转发成功时**记下的
 * 渠道（`activeProvider()`，纯内存读）。两者在以下情况会**不一致**：
 * 预测的胜者可能因上游失败而被切换掉，于是「预测的渠道」与「实际用的渠道」不同。
 * 用户明确选择了真实历史（显示一个错的渠道比不显示更误导）。
 *
 * ⇒ 全仓**零调用方**是本函数的现状，**保留它是有意的**（不删，避免越界改动
 * PR !69 的成果）。若要给聚合徽标接线，用 `aggregate.activeProvider`，
 * **不要**改成调本函数。
 */
export async function pickCurrentAutoProvider(ctx, options) {
    const probe = new AutoAdapter(ctx, options);
    // ⚠️ 必须带 `modelOf`：**模型全被关闭的 provider 不能算进徽标**（PR !69 审计实测），
    // 否则徽标会显示一个 auto 实际根本不会选中的 provider。
    const picked = await probe.selectProvider(undefined, p => probe.firstModelOf(p));
    return picked?.provider;
}
//# sourceMappingURL=auto-adapter.js.map