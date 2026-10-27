import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { REASONING_LOOP_CODE, resolveReasoningLoopGuardFlag } from './sse.js';
/**
 * 自动续跑消息的**自有来源标识**。
 *
 * ⚠️⚠️ **绝不能再用 `{ kind: 'user' }`**（Issue IKLEOW 根因 3）。按 harness 的
 * 既有约定，`source.kind === 'user'` 是**宿主对「直接人类输入」的证明**，
 * 不是一个渲染标签：`tool-goal` 的 create / edit / pause / resume 都要求
 * 「当前轮次存在直接人类消息」才放行（见 `packages/goal/tool-goal/README.md`
 * 的「Host attestation of human input」）。伪造成 `user` 会让自动续跑**冒用
 * 人类授权**，模型据此可以创建 / 改写 / 恢复目标；UI 也会把它渲染成用户发言。
 *
 * ⚠️ 0.1.7 之前的 `MessageSourceMap` 只有一个共享的 `plugin` 包装，本插件当时
 * 因此只能借用 `user`；**0.2.0 起 source kind 由**生产者自己**声明**
 * （`MessageSourceMap` 已删除 `plugin`，改为合并扩展），故现在可以如实署名。
 */
export const LOOP_RESUME_SOURCE_KIND = 'loop-resume';
/**
 * 自动续跑时投递的 user 消息正文。
 *
 * ⚠️ 它是**模型可见且会落盘**的文本（不是日志），故按「给模型的指令」写：
 * 说清三件事 —— ①继续未完成的任务；②为什么上一轮停了（思考重复，**不是**
 * 任务做完）；③这次要换思路。不写 harness 内部词汇（「循环守卫」「去重率」），
 * 那是给用户看的诊断，模型只需要知道「上一轮那样想没用」。
 */
export const LOOP_RESUME_PROMPT = '继续未完成的任务。上一轮你的思考陷入了重复（同一段推理反复出现）'
    + '而被中止 —— 请换一种思路，不要重复刚才那段推理，直接推进任务。';
/** 连续自动续跑的**默认**上限（次）。 */
export const LOOP_RESUME_DEFAULT_MAX = 2;
/**
 * `…_MAX` 的硬上限。
 *
 * 单次循环只烧约 2000 字符（实测），2 次已足够覆盖「换个思路就能继续」的
 * 绝大多数情况；再往上配（比如 999）不是配置而是事故 —— 真要无限跑，
 * 用户该用的是 goal（`create_goal`）而不是这个兜底。
 */
export const LOOP_RESUME_MAX_LIMIT = 10;
/** 总开关环境变量；**默认开启**，与 `DSH_REASONING_LOOP_GUARD` 同族。 */
export const LOOP_RESUME_FLAG_ENV = 'DSH_REASONING_LOOP_AUTO_RESUME';
/** 连续次数上限环境变量；`0` 是**合法**值（= 一次都不续跑）。 */
export const LOOP_RESUME_MAX_ENV = 'DSH_REASONING_LOOP_AUTO_RESUME_MAX';
/**
 * 归一化 `…_MAX`。
 *
 * ⚠️ **非法值回默认值，而不是回 0**：`0` 是「绝不自动续跑」的**合法**配置，
 * 若把 `=abc` 也变成 0，用户拼错一次就会以为「功能没生效」却查不出原因
 * （与本仓库既有教训同型：`parseInt(…) || 默认值` 会把合法的 `0` 静默吞掉）。
 *
 * @param raw - 环境变量原文；`undefined` / 空白视为未设置。
 * @returns 归一化后的上限（整数、非负、≤ {@link LOOP_RESUME_MAX_LIMIT}）。
 */
export function resolveLoopResumeMax(raw) {
    const text = raw?.trim() ?? '';
    if (text === '')
        return LOOP_RESUME_DEFAULT_MAX;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0)
        return LOOP_RESUME_DEFAULT_MAX;
    return Math.min(value, LOOP_RESUME_MAX_LIMIT);
}
/**
 * 读取自动续跑策略。
 * @param env - 环境变量来源，默认 `process.env`（单测注入用）。
 * @returns 归一化后的策略。
 */
export function resolveLoopResumePolicy(env = process.env) {
    return {
        // 复用循环守卫自己的开关语义（默认开、显式假值才关），避免两处各写一份。
        enabled: resolveReasoningLoopGuardFlag(env[LOOP_RESUME_FLAG_ENV]),
        maxResumes: resolveLoopResumeMax(env[LOOP_RESUME_MAX_ENV]),
    };
}
/**
 * 判断一个错误是不是「思考死循环中止」。
 *
 * ⚠️ **不能只靠 `instanceof LlmError`**：`@deepseek-ai/dsh-llm` 在宿主与插件里
 * 可能解析成**两份模块实例**（宿主自带副本 + profile 里另一份），此时
 * `instanceof` 恒为 `false`，表现是「功能完全没反应而且没有任何报错」——
 * 极难定位。故这里再按**错误码**认一次：`REASONING_LOOP` 是本插件自己定义的
 * 常量（`sse.ts`），误判风险为零。
 *
 * @param error - `agent/error` 载荷里的原样错误。
 * @returns 是否为循环中止。
 */
export function isReasoningLoopFailure(error) {
    if (error instanceof LlmError)
        return error.code === REASONING_LOOP_CODE;
    if (typeof error !== 'object' || error === null)
        return false;
    return error.code === REASONING_LOOP_CODE;
}
const defaultSchedule = (task) => { queueMicrotask(task); };
/**
 * 判断一条消息是否由本插件的自动续跑投出。
 *
 * ⚠️ 按 **`source.kind`** 认，而不是按 message id：id 只在单进程内有效，
 * 而 source 会随消息落盘，重放 / 重启后仍可辨认。
 *
 * @param source - 消息的 `source` 字段（未知形状按「不是」处理）。
 * @returns 是否为自动续跑消息。
 */
export function isLoopResumeSource(source) {
    return typeof source === 'object' && source !== null
        && source.kind === LOOP_RESUME_SOURCE_KIND;
}
/**
 * 「**别人真的介入了**」的来源词表 —— 只有这些清零连续续跑预算。
 *
 * ## 为什么需要一张显式的白名单，而不是「除我之外都算」
 *
 * 收件箱里除了人类与会话级参与者的输入，还有大量**自动注入的上下文通知**。
 * 全量会话取证（721 个会话，扫 `agent/inbox/spliced` 的 `inserted[].source.kind`）
 * 得到的真实词表与频次：
 *
 * | kind | 会话数 | 总次数 | 性质 |
 * |---|---|---|---|
 * | `user` | 712 | 2945 | **人类输入**（宿主证明）|
 * | `tool-jobs` | 130 | 320 | 后台任务通知（自动）|
 * | `agent-message` | 122 | 436 | **别的 agent 发来的** |
 * | `agent-instructions` | 97 | 305 | 工作区指令刷新（自动）|
 * | `subagent-settled` | 68 | 349 | **子代理收尾** |
 * | `goal` | 13 | 315 | **目标驱动器排的下一轮** |
 * | `repeat-tool-reminder` | 11 | 12 | 重复工具提醒（自动）|
 * | `tool-goal` | 10 | 14 | 目标工具的收尾说明（自动）|
 * | `user-approval` | 5 | 5 | **人工审批结果** |
 *
 * 「连续续跑上限」的语义是「**在没有任何新的人类 / 会话级输入的情况下**，
 * 我们最多替模型续跑几次」。自动通知不构成这种输入 —— 若把它们也算介入，
 * 一个每步都注入通知的插件就能**架空**这个上限（这正是 issue IKLEOW 根因 2
 * 担心的形态；⚠️ 但**它描述的 `runtime-context` 路径并不成立**，见下）。
 *
 * ## ⚠️ 如实说明：这是**健壮性**修正，真实会话未显现
 *
 * issue 根因 2 声称「harness 自身的 `runtime-context` 注入会把预算反复清零，
 * 导致自动续跑**无界**」。实测**推翻了这条归因**：
 *
 * 1. `runtime-context` **根本不走 `agent/inbox/inserted`** —— 它是 `preStep`
 *    里经 `runtimeContext.project()` 直接拼进本次请求的（见
 *    `packages/core/agent-loop/src/agent.ts` 的 `preStep`），故从不出现在
 *    上面那张词表里（721 个会话零命中）。
 * 2. 全量回放 13 个含循环中止的会话，**连续续跑从未超过 2**（= 默认上限），
 *    也从未触发过上限告警。
 * 3. 把判据从「宽」（除我之外都清零）换成「窄」（只有真介入才清零），
 *    **13 个会话的结果逐个相同**（投出次数、上限告警数完全一致）。
 *
 * ⇒ 本白名单**不是**修复一个已发生的缺陷，而是**防止**「某个每步注入通知的
 * 插件把上限架空」这一形态（防御性收窄）。写在这里是为了让后来者**不必**
 * 再靠猜：真实词表与「无行为差异」的结论都已实测。
 */
const INTERVENTION_SOURCE_KINDS = new Set([
    'user', // 人类输入（宿主证明，见 LOOP_RESUME_SOURCE_KIND 的注释）
    'goal', // 目标驱动器排的下一轮 —— 目标由用户设定
    'agent-message', // 别的 agent 发来的消息
    'subagent-settled', // 子代理收尾
    'subagent-report',
    'user-approval', // 人工审批结果
]);
/**
 * 判断一条收件箱插入是否代表「别人真的介入了」。
 *
 * @param source - 消息的 `source` 字段。
 * @returns 是否清零连续续跑预算。
 */
export function isInterventionSource(source) {
    if (typeof source !== 'object' || source === null)
        return false;
    const kind = source.kind;
    return typeof kind === 'string' && INTERVENTION_SOURCE_KINDS.has(kind);
}
/** 收件箱是否有待处理输入（`hasPending` 的契约内等价写法）。 */
function inboxHasPending(inbox) {
    return inbox.nextTurn.length > 0 || inbox.nextStep.length > 0;
}
/**
 * 创建自动续跑控制器。
 * @param options - 策略、日志出口与投递动作。
 * @returns 控制器；内部状态按 `agent.id` 记，`forget()` 清理。
 */
export function createLoopResumeController(options) {
    const { policy, log } = options;
    const deliver = options.deliver ?? ((agent, message) => { agent.followup(message); });
    const schedule = options.schedule ?? defaultSchedule;
    const states = new Map();
    function stateFor(agent) {
        const existing = states.get(agent.id);
        if (existing !== undefined)
            return existing;
        const state = { attempts: 0, pending: false, scheduled: false, injected: new Set() };
        states.set(agent.id, state);
        return state;
    }
    /**
     * 真正投递。**必须只在排定的任务里调用**（此时已脱离 `agent/status` 派发栈）。
     *
     * ⚠️⚠️ **本函数绝不能在 `agent/status` 的同步派发栈内执行**（Issue IKLEOW
     * 根因 1）：`agent.followup()` 会经 `wakeDriver()` 把相位改回 `running` 并
     * **再次同步派发 `agent/status`**，而那一次派发是嵌套在「派发 idle」的
     * 栈里的。于是同一次 idle 转换产生两个方向相反的信号，客户端最终采用哪
     * 一个取决于监听器注册顺序 —— 若本插件的监听器排在 `session-controller`
     * 之前，外层那条**陈旧的 `idle`** 会覆盖嵌套的 `running`，表现为
     * **agent 正在跑新一轮而客户端 `running = false`**：Stop 按钮消失、插话
     * 被置灰且在服务端被 `session/steer-unavailable` 拒绝（三者共用同一个
     * running 位）。真实复现实测（本机 `0.2.0-rc.2` 运行时）：
     * `plugin-first` 顺序下序列为 `[true,true,false,false]`，且第 2 次请求
     * 开始时 `agent=running` 而 `clientRunning=false`；`controller-first`
     * 顺序下则是 `[true,false,true,false]` 且全程一致。
     *
     * @param agent - 目标 agent。
     * @param state - 该 agent 的进程内状态（已确认仍属于当前注册表）。
     * @returns 是否真的投出去了。
     */
    function deliverNow(agent, state) {
        // ⚠️ **脱离派发栈之后重新校验**（Issue IKLEOW 建议 2）：排队期间相位可能
        // 已被别的监听器改回 running，或已有别人排了活。这里读到的是**权威值**，
        // 而 `observeIdle` 里那次读取只是便宜的前置过滤。
        if (agent.status !== 'idle')
            return false;
        if (inboxHasPending(agent.inbox))
            return false;
        // 上限在 `observeIdle` 已判过（并会告警）；这里只做无告警的复核，防止
        // 「排定之后又失败」的交错。重复告警会把有用信息埋掉，故不在此再 warn。
        if (state.attempts > policy.maxResumes)
            return false;
        let injectedId;
        try {
            const message = createUserMessage({
                content: [{ type: 'text', text: LOOP_RESUME_PROMPT }],
                // ⚠️⚠️ **自有 source kind，绝不伪造成 `'user'`**（Issue IKLEOW 根因 3）：
                // `source.kind === 'user'` 是宿主对「直接人类输入」的**证明**，
                // `tool-goal` 的 create / edit / pause / resume 都据此授权。详细理由见
                // `LOOP_RESUME_SOURCE_KIND` 的注释。
                source: { kind: LOOP_RESUME_SOURCE_KIND },
            });
            injectedId = message.id;
            state.injected.add(message.id);
            deliver(agent, message);
        }
        catch (error) {
            if (injectedId !== undefined)
                state.injected.delete(injectedId);
            log.warn(`[codearts-auth] 自动续跑投递失败（${agent.id}）：${String(error)}`);
            return false;
        }
        log.info(`[codearts-auth] ${agent.id} 思考陷入重复被中止，已自动续跑`
            + `（第 ${state.attempts}/${policy.maxResumes} 次）。`);
        return true;
    }
    return {
        observeFailure(agent, error) {
            const state = stateFor(agent);
            if (!isReasoningLoopFailure(error)) {
                // 别的失败（TRANSPORT / QUOTA / AUTH …）说明「连续循环」已经断了：
                // 清零预算，让下一次真循环重新有额度。此处**不**置 pending —— 续跑
                // 只对循环中止负责，别的错误续跑只会掩盖真故障。
                state.attempts = 0;
                state.pending = false;
                return;
            }
            state.attempts += 1;
            state.pending = true;
        },
        observeIdle(agent) {
            const state = states.get(agent.id);
            if (state === undefined || !state.pending)
                return false;
            // 先清 pending：无论下面走哪条分支，这次失败都已经处理过了，
            // 否则后续每一次 idle 都会重试一遍（无界）。
            state.pending = false;
            if (state.attempts > policy.maxResumes) {
                log.warn(`[codearts-auth] ${agent.id} 连续第 ${state.attempts} 次思考陷入重复，`
                    + `已达到自动续跑上限（${policy.maxResumes} 次），不再自动续跑 —— `
                    + '建议降低思考档位或更换模型。');
                return false;
            }
            // 便宜的前置过滤（真正的判据在 `deliverNow` 里，见其注释）。
            if (agent.status !== 'idle')
                return false;
            if (inboxHasPending(agent.inbox))
                return false;
            if (state.scheduled)
                return false;
            state.scheduled = true;
            // ⚠️ **脱离当前派发栈**再投递 —— 这是本函数**唯一**的投递路径。
            //
            // 返回值语义：同步调度器（单测注入 `task => task()`）下投递当场完成，
            // 故如实返回**投递结果**；生产默认的 `queueMicrotask` 下投递尚未发生，
            // 只能如实返回「**已排定**」。调用方（`agent/status` 监听器）不依赖
            // 这个返回值做判断，它只用于测试与诊断。
            let delivered = false;
            let settled = false;
            schedule(() => {
                state.scheduled = false;
                // agent 可能已被 dispose（`forget` 删掉了状态）：那时不再投递。
                if (states.get(agent.id) !== state) {
                    settled = true;
                    return;
                }
                delivered = deliverNow(agent, state);
                settled = true;
            });
            return settled ? delivered : true;
        },
        observeInput(agent, message) {
            const state = states.get(agent.id);
            if (state === undefined)
                return;
            // 我们自己投的那条：既不算「别人介入」，也不该占着标记不放。
            if (state.injected.delete(message.id))
                return;
            // ⚠️ 再按**来源标识**认一次：单进程内 id 已经够用，但重放 / 跨进程时
            // id 对不上而 source 仍在日志里，故这条判据更稳（0.2.0 起本插件已有
            // 自有的 source kind，见 `LOOP_RESUME_SOURCE_KIND`）。
            if (isLoopResumeSource(message.source))
                return;
            // ⚠️ **只有「别人真的介入」才清零**（Issue IKLEOW 建议 3）：自动注入的
            // 上下文通知（`agent-instructions` / `tool-jobs` / `repeat-tool-reminder` …）
            // 不构成「有人替模型说话了」，把它们算成介入会让上限被架空。
            // 真实词表、频次与「这是健壮性修正而非已发生缺陷」的实测结论见
            // `INTERVENTION_SOURCE_KINDS` 的注释。
            if (!isInterventionSource(message.source))
                return;
            state.attempts = 0;
            state.pending = false;
        },
        forget(agent) {
            states.delete(agent.id);
        },
        attemptsOf(agentId) {
            return states.get(agentId)?.attempts ?? 0;
        },
    };
}
/**
 * 装上自动续跑（在插件 `apply()` 里调用一次）。
 *
 * ⚠️ `agents` 用 `ctx.inject([...])` 而**不**写进静态 `inject`：宿主侧 agent-loop
 * 缺席的 profile（纯 `ctx.llm` 的脚本、部分 headless 场景）里静态 inject 会让
 * 本插件**永久 pending**，整个 profile 启动失败（与 `connection` 同理，见
 * `index.ts` 的 `inject` 注释）。缺席时本功能整体不生效，其余 provider 照常。
 *
 * @param ctx - 插件上下文。
 */
export function installLoopResume(ctx) {
    const policy = resolveLoopResumePolicy();
    if (!policy.enabled || policy.maxResumes === 0) {
        ctx.logger.info(`[codearts-auth] 思考循环后的自动续跑未启用（${LOOP_RESUME_FLAG_ENV} / ${LOOP_RESUME_MAX_ENV}）。`);
        return;
    }
    ctx.inject(['agents'], (scope) => {
        const controller = createLoopResumeController({
            policy,
            log: ctx.logger,
            // ⚠️ 用 `withoutInitiator()` 排队：排队动作不该继承「当时恰好是谁在
            // 运行」的发起者归属 —— 与 harness 自己的 `goal-round-driver` 同一手法。
            //
            // ⚠️ 虽然投递已由控制器挪出 `agent/status` 派发栈（见 `deliverNow` 的
            // 注释），这里**仍然保留** `withoutInitiator()`：投递时刻虽已不是
            // 「正在派发状态事件」，但微任务之间仍可能夹着别的 agent 的驱动，而
            // 「自动续跑不是任何人的子任务」这条语义与调用时机无关。
            deliver: (agent, message) => { scope.agents.withoutInitiator(() => { agent.followup(message); }); },
        });
        scope.on('agent/error', ({ agent, error }) => { controller.observeFailure(agent, error); });
        scope.on('agent/status', ({ agent, status }) => {
            if (status === 'idle')
                controller.observeIdle(agent);
        });
        scope.on('agent/inbox/inserted', ({ agent, message }) => { controller.observeInput(agent, message); });
        scope.on('agent/disposed', ({ agent }) => { controller.forget(agent); });
    });
}
//# sourceMappingURL=loop-recovery.js.map