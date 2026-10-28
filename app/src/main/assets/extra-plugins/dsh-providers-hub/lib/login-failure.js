/**
 * 登录失败的**语义标记**（Jet Hub 登录链路的共享契约）。
 *
 * ## 为什么需要它（2026-10-20 用户报障）
 *
 * `jet-hub-rpc.ts` 的 `loginFailureMessage()` 原先**无条件**给所有登录失败拼上
 * 「请重新点击「+ 新建账号」」。但有一类失败的**出路在外部** —— 最典型的是
 * OfficeAce 的「该账号尚未开通 ModelArts MaaS」：开通与授权只能在**果办客户端**
 * 里做，重新点「+ 新建账号」只会重走一遍 OAuth 然后**再失败一次**
 * ⇒ 那半句是**假出路**，把用户锚在一个永远不会成功的动作上。
 *
 * ⚠️ 与本仓库既有的那条纪律同向（`docs/agent-notes/client-ui.md` 的 IKLBSH）：
 *    「凡『文案本身就是出路』的错误，不得让通用后缀/通用错误码把它冲淡」——
 *    这类失败的指路句是**唯一**有用的信息。
 *
 * ## 判据为什么是**标记**而不是匹配文案
 *
 * 匹配文案（例如 `/尚未开通/`）一改就失效，且属于本仓库明令的
 * 「一文件两套同义判据」形态。标记由**抛错方**打下 —— 只有它知道
 * 「这个失败重试有没有意义」。
 *
 * ⚠️ 用 `Symbol.for`（全局注册表）而不是模块局部 `Symbol`：抛错方与消费方分属
 *    不同模块；`instanceof` 式的类身份检查在本仓库踩过「跨模块副本假红」的坑。
 *    ⚠️ 用 `Object.defineProperty` 写成**不可枚举**：错误对象可能被
 *    `JSON.stringify` 或日志展开，不该多出一个奇怪的自定义键。
 */
const NEEDS_EXTERNAL_ACTION = Symbol.for('dsh-providers-hub/loginNeedsExternalAction');
/**
 * 标记一次登录失败为「**重试无用**，出路在外部」。
 *
 * ## 适用判据（必须逐条满足）
 *
 * **重新点「+ 新建账号」（= 重走一遍本插件的授权）不可能让它成功** ——
 * 必须由用户去**别处**完成一个动作。当前标记它的两处：
 *
 * | 失败 | 出路在哪 |
 * |---|---|
 * | OfficeAce「该账号尚未开通 ModelArts MaaS」 | **果办客户端**：用该账号点「开通」并同意授权 |
 * | AStudio「本机找不到登录会话 / 会话已失效」 | **AStudio 桌面端**：重新微信扫码登录 |
 *
 * ## ⚠️ 明确**不适用**的情形（这些必须保留通用后缀）
 *
 * - 网络抖动 / 超时 / 服务端 5xx —— 重试**有意义**；
 * - 用户自己关掉了授权弹窗 —— 重试正是他要做的；
 * - 账号级限流 / 内容级拦截 —— 出路是**换号**，而「重新登录」是换号入口。
 *
 * ⇒ 误标的代价是**把真出路藏起来**（与本模块要修的问题同型），
 *    所以「拿不准就别标」。
 */
export function markLoginNeedsExternalAction(error) {
    Object.defineProperty(error, NEEDS_EXTERNAL_ACTION, {
        value: true,
        enumerable: false,
        configurable: true,
    });
    return error;
}
/**
 * 判据：这次登录失败是否被标记为「重试无用，出路在外部」。
 *
 * ⚠️ 只认**本模块打的标记**（同一个 `Symbol.for` 键 + 值恒为 `true`）。
 *    非对象 / 未标记 / 值不严格等于 `true` 一律返回 `false`
 *    ⇒ 调用方据此**保留**通用后缀（fail-closed 的方向是「照旧提示重试」，
 *    因为误留后缀只是不精确，误删后缀会让用户不知道该做什么）。
 */
export function loginNeedsExternalAction(reason) {
    return typeof reason === 'object' && reason !== null
        && reason[NEEDS_EXTERNAL_ACTION] === true;
}
//# sourceMappingURL=login-failure.js.map