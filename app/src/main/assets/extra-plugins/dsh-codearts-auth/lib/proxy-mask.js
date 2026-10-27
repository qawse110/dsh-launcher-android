/**
 * 代理 URL 的**脱敏**（全仓唯一一份）。
 *
 * ## 为什么单独一个中立模块
 *
 * 它的两个消费侧在依赖图上**方向相反**：
 *
 * - `src/opencode.ts`（provider 实现）—— 造 `NormalizedProxy.label` 时用；
 * - `src/account-pool.ts`（底层池）—— 写「代理已更新」日志时用。
 *
 * 池**不能** import provider 实现（那会让底层依赖上层，并可能成环），
 * 而复制一份到池里就正是本仓库的红线「**同一语义两套判据**」
 * （2026-10-25 审计 A2-02 实测：四家 `set*Proxy` 都明文打印代理口令，
 * 而 `opencode.ts` 里**早就**有脱敏实现 —— 池拿不到它，于是各打各的）。
 *
 * ⇒ 判据住在这个**双方都能依赖**的中立文件里，两侧都只 import 它。
 *
 * ## ⚠️ 只做一件事：把 userinfo 里的口令换成 `***`
 *
 * 保留 scheme、用户名、host、port（排查时全靠这些信息），只吃掉 `:` 与 `@`
 * 之间的口令。**不做** `new URL()` 解析：那个 API 会把显式默认端口抹掉
 * （`new URL('https://h:443').port === ''`），也会对非法输入整体抛错 ——
 * 而本函数的调用点常在**错误路径**上（要展示「你填的这个地址有问题」），
 * 那里更不能因为「地址本身不合法」而再抛一次。
 */
export function maskProxyPassword(url) {
    return url.replace(/^(\w+:\/\/[^:@/]+):[^@/]*@/, '$1:***@');
}
//# sourceMappingURL=proxy-mask.js.map