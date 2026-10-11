import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { REASONING_LOOP_CODE, resolveReasoningLoopGuardFlag } from './sse.js';
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
/**
 * 创建自动续跑控制器。
 * @param options - 策略、日志出口与投递动作。
 * @returns 控制器；内部状态按 `agent.id` 记，`forget()` 清理。
 */
export function createLoopResumeController(options) {
    const { policy, log } = options;
    const deliver = options.deliver ?? ((agent, message) => { agent.followup(message); });
    const states = new Map();
    function stateFor(agent) {
        const existing = states.get(agent.id);
        if (existing !== undefined)
            return existing;
        const state = { attempts: 0, pending: false, injected: new Set() };
        states.set(agent.id, state);
        return state;
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
            // 防御性再确认：本函数由 `agent/status` 的 idle 分支调用，但状态可能
            // 在该事件与本次调用之间被别的监听器改回 running。
            if (agent.status !== 'idle')
                return false;
            // 已经有人排了活（用户手打了、目标驱动器排了下一轮）→ 让它跑，
            // 我们插一脚只会多烧一轮。
            if (agent.inbox.hasPending)
                return false;
            // ⚠️ 构造 + 投递整体兜住：本函数跑在宿主的 `agent/status` 派发里，让异常
            // 冒到派发方会污染宿主的事件链，而我们只是「额外帮忙」，失败必须是降级。
            let injectedId;
            try {
                const message = createUserMessage({
                    content: [{ type: 'text', text: LOOP_RESUME_PROMPT }],
                    // `kind: 'user'`：这就是一条普通用户指令（与用户手打「继续」同形），
                    // 故 UI 显示、落盘、重放全部走既有路径，无需任何格式变更。
                    source: { kind: 'user' },
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
        },
        observeInput(agent, message) {
            const state = states.get(agent.id);
            if (state === undefined)
                return;
            // 我们自己投的那条：既不算「别人介入」，也不该占着标记不放。
            if (state.injected.delete(message.id))
                return;
            // 别人（用户 / 目标驱动器 / 子代理）投了消息 → 预算清零。
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
            // ⚠️ 用 `withoutInitiator()` 排队：这几行跑在别的 agent 的事件派发里
            // （`agent/status` / `agent/error`），排队动作不该继承「当时恰好是谁在
            // 运行」的发起者归属 —— 与 harness 自己的 `goal-round-driver` 同一手法。
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